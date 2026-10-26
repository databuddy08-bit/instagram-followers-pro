// Instagram with the user's own session: cookie parsing, one sticky identity, paced requests, account-safety stops,
// follower/following paging, profile lookups and row building.
import { gotScraping } from 'got-scraping';

export const IG = process.env.IG_BASE ?? 'https://www.instagram.com';
const APP_ID = '936619743392459';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BACKOFF = Number(process.env.HTTP_BACKOFF_SCALE ?? 1);
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms * BACKOFF)));

/** The run must stop to protect the account (challenge, action block, expired login, repeated rate limits). */
export class AccountStop extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
export class StoppedError extends Error {}

// ---------- Cookie ----------

/**
 * Accepts a Cookie header ("sessionid=…; csrftoken=…"), a browser-extension JSON export ([{name,value}…]),
 * or just the sessionid value. Returns {header, sessionid, csrftoken, dsUserId} or throws with a helpful message.
 */
export function parseCookie(raw) {
    const text = String(raw ?? '').trim();
    if (!text) throw new Error('Add your Instagram session cookie (see "How to get your session cookie" in the README).');
    const jar = {};
    if (text.startsWith('[') || text.startsWith('{')) {
        let j;
        try {
            j = JSON.parse(text);
        } catch {
            throw new Error('The cookie looks like JSON but could not be read. Paste the export again, or just the "sessionid" value.');
        }
        for (const c of Array.isArray(j) ? j : Object.entries(j).map(([name, value]) => ({ name, value }))) if (c?.name) jar[c.name] = String(c.value ?? '');
    } else if (/=/.test(text)) {
        for (const part of text.replace(/^cookie:\s*/i, '').split(';')) {
            const i = part.indexOf('=');
            if (i > 0) jar[part.slice(0, i).trim()] = part.slice(i + 1).trim();
        }
    } else jar.sessionid = text;
    if (!jar.sessionid) throw new Error('No "sessionid" found in the cookie. Copy the sessionid cookie of instagram.com from a logged-in browser.');
    const sid = decodeURIComponent(jar.sessionid);
    jar.ds_user_id = jar.ds_user_id ?? sid.match(/^(\d+):/)?.[1];
    const header = Object.entries(jar).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('; ');
    return { header, sessionid: jar.sessionid, csrftoken: jar.csrftoken ?? null, dsUserId: jar.ds_user_id ?? null };
}

// ---------- Input ----------

const RESERVED = new Set(['p', 'reel', 'reels', 'explore', 'stories', 'accounts', 'direct', 'tv', 'about', 'developer', 'legal']);
export function parseProfileInput(raw) {
    const input = String(raw ?? '').trim();
    if (!input) return null;
    if (/^@?[a-zA-Z0-9._]{1,30}$/.test(input)) return { username: input.replace(/^@/, '').toLowerCase(), input };
    let u;
    try {
        u = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
    } catch {
        return { invalid: true, input, error: 'not an Instagram username or profile URL' };
    }
    if (!/(^|\.)instagram\.com$/.test(u.hostname)) return { invalid: true, input, error: 'not an instagram.com URL' };
    const seg = u.pathname.split('/').filter(Boolean);
    if (!seg[0] || RESERVED.has(seg[0].toLowerCase()) || !/^[a-zA-Z0-9._]{1,30}$/.test(seg[0])) return { invalid: true, input, error: 'use a profile URL like instagram.com/username (post and reel URLs are not profiles)' };
    const list = seg[1] === 'followers' ? 'followers' : seg[1] === 'following' ? 'following' : null;
    return { username: seg[0].toLowerCase(), list, input };
}

// ---------- Client ----------

/**
 * One identity for the whole run: same cookie, same proxy session (IP), one request at a time with human-like pauses.
 * Never rotates IP on trouble — a logged-in session hopping IPs is what triggers Instagram's checks.
 */
export function makeInstagram({ cookie, proxyConfiguration, msLeft, stats, pace }) {
    const sessionId = `ig${Math.random().toString(36).slice(2, 10)}`;
    let last = 0;
    let rateLimitHits = 0;

    async function wait(kind) {
        const [lo, hi] = kind === 'profile' ? pace.profile : pace.page;
        const gap = (lo + Math.random() * (hi - lo)) * 1000;
        const due = last + gap * BACKOFF;
        while (Date.now() < due) {
            if (msLeft() <= 0) throw new StoppedError('run stopping');
            await new Promise((r) => setTimeout(r, Math.min(500, due - Date.now())));
        }
    }

    async function get(path, { kind = 'page', referer } = {}) {
        for (let attempt = 0; attempt < 3; attempt++) {
            if (msLeft() <= 0) throw new StoppedError('run stopping');
            await wait(kind);
            last = Date.now();
            stats.requests += 1;
            let res;
            try {
                res = await gotScraping({
                    url: `${IG}${path}`,
                    headers: {
                        'user-agent': UA, accept: '*/*', 'accept-language': 'en-US,en;q=0.9', 'x-ig-app-id': APP_ID, 'x-requested-with': 'XMLHttpRequest', 'x-asbd-id': '359341', 'x-ig-www-claim': '0',
                        ...(cookie.csrftoken ? { 'x-csrftoken': cookie.csrftoken } : {}), cookie: cookie.header, referer: referer ?? `${IG}/`,
                    },
                    useHeaderGenerator: false,
                    proxyUrl: proxyConfiguration ? await proxyConfiguration.newUrl(sessionId) : undefined,
                    responseType: 'text', throwHttpErrors: false, retry: { limit: 0 }, followRedirect: false, timeout: { request: 30000 },
                });
            } catch (err) {
                stats.networkErrors += 1;
                if (attempt === 2) throw new Error(`network error: ${err.code ?? err.message}`);
                await sleep(5000 * (attempt + 1));
                continue;
            }
            let json = null;
            try {
                json = JSON.parse(res.body);
            } catch { /* HTML / redirect */ }
            const msg = `${json?.message ?? ''} ${json?.error_type ?? ''}`;
            const loc = res.headers.location ?? '';
            if (/challenge|checkpoint/i.test(msg) || /challenge|checkpoint/.test(loc) || json?.checkpoint_url) {
                throw new AccountStop('challenge', 'Instagram asked this account to confirm it is you (security check). Open Instagram in the app or browser with this account, complete the check, wait a few hours, then copy a fresh session cookie.');
            }
            if (/feedback_required|action ?blocked|try again later/i.test(msg) || json?.spam) {
                throw new AccountStop('action_block', 'Instagram temporarily limited this account ("try again later"). Wait 24 hours before the next run, and use lower limits / longer pauses.');
            }
            if (res.statusCode === 302 && /accounts\/login/.test(loc)) throw new AccountStop('login_expired', 'The session cookie is not logged in (expired or logged out). Log in to Instagram in your browser and copy a fresh sessionid cookie.');
            if (json?.require_login || /login_required/i.test(msg)) throw new AccountStop('login_expired', 'The session cookie is not logged in (expired or logged out). Log in to Instagram in your browser and copy a fresh sessionid cookie.');
            if (res.statusCode === 429 || /please wait a few minutes/i.test(msg)) {
                rateLimitHits += 1;
                stats.rateLimited += 1;
                if (rateLimitHits >= 3 || attempt === 2) throw new AccountStop('rate_limited', 'Instagram rate-limited this account several times. Stopping to protect it — the next run resumes where this one stopped. Wait an hour or two first.');
                await sleep(60000 * (attempt + 1));
                continue;
            }
            if (res.statusCode >= 500) {
                await sleep(5000);
                continue;
            }
            return { status: res.statusCode, json, body: res.body };
        }
        throw new Error('request failed repeatedly');
    }

    /** Confirms the cookie is logged in. Returns the viewer's username. */
    async function whoAmI() {
        const r = await get('/api/v1/accounts/current_user/?edit=true', { kind: 'profile' });
        const u = r.json?.user;
        if (!u?.username) throw new AccountStop('login_expired', 'The session cookie is not logged in (expired or logged out). Log in to Instagram in your browser and copy a fresh sessionid cookie.');
        return { username: u.username, pk: String(u.pk ?? u.pk_id ?? '') };
    }

    /** Full public profile of a username (works for any public account; private ones return basics). */
    async function profile(username) {
        const r = await get(`/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`, { kind: 'profile', referer: `${IG}/${username}/` });
        if (r.status === 404 || (r.json && r.json.data && r.json.data.user === null)) return null;
        const u = r.json?.data?.user;
        if (!u) throw new Error(`profile lookup failed (HTTP ${r.status})`);
        return u;
    }

    /** One page of followers / following. */
    async function listPage(userId, username, which, cursor, count) {
        const qs = new URLSearchParams({ count: String(count), ...(cursor ? { max_id: cursor } : {}), ...(which === 'followers' ? { search_surface: 'follow_list_page' } : {}) });
        const r = await get(`/api/v1/friendships/${userId}/${which}/?${qs}`, { referer: `${IG}/${username}/${which}/` });
        if (r.status === 400 || r.status === 403 || /not authorized|private/i.test(r.json?.message ?? '')) throw Object.assign(new Error(`this account cannot see ${username}'s ${which} (private profile not followed by you, or hidden list)`), { notAllowed: true });
        if (r.status === 404) throw Object.assign(new Error('profile not found'), { notFound: true });
        if (!Array.isArray(r.json?.users)) throw new Error(`unexpected answer for ${which} (HTTP ${r.status})`);
        return { users: r.json.users, next: r.json.next_max_id ? String(r.json.next_max_id) : null, bigList: Boolean(r.json.big_list) };
    }

    return { whoAmI, profile, listPage };
}

// ---------- Rows ----------

const DIGITS = /\d{4,}|\d{2,}[._]\d{2,}/;
/** Signals that often mark low-quality or inactive accounts. Signals only — not a verdict. */
export function qualitySignals(u, prof) {
    const s = [];
    if (u.has_anonymous_profile_picture || /44884218_345707102882519_2446069589734326272_n|anonymous_profile_pic/.test(u.profile_pic_url ?? '')) s.push('no_profile_pic');
    if (!String(u.full_name ?? '').trim()) s.push('no_full_name');
    if (DIGITS.test(u.username ?? '')) s.push('digit_heavy_username');
    if (prof) {
        const posts = prof.edge_owner_to_timeline_media?.count;
        const followers = prof.edge_followed_by?.count;
        const following = prof.edge_follow?.count;
        if (posts === 0) s.push('no_posts');
        if (typeof following === 'number' && following > 1000 && typeof followers === 'number' && following > followers * 10) s.push('follows_far_more_than_followers');
        if (!String(prof.biography ?? '').trim()) s.push('no_bio');
    }
    return s;
}

export function listRow(u, src, type, position) {
    const id = String(u.pk ?? u.pk_id ?? u.id ?? '');
    return {
        sourceUsername: src.username,
        userId: id,
        username: u.username,
        fullName: u.full_name ?? '',
        profilePicUrl: u.profile_pic_url ?? null,
        isVerified: Boolean(u.is_verified),
        isPrivate: Boolean(u.is_private),
        type,
        // ---- additions ----
        sourceUserId: src.userId,
        profileUrl: `https://www.instagram.com/${u.username}/`,
        hasProfilePic: !qualitySignals(u).includes('no_profile_pic'),
        hasActiveStory: Boolean(u.latest_reel_media),
        position,
    };
}

export function enrichment(p) {
    const followers = p.edge_followed_by?.count ?? null;
    return {
        biography: p.biography ?? '',
        externalUrl: p.external_url ?? null,
        bioLinks: (p.bio_links ?? []).map((l) => l.url).filter(Boolean),
        followersCount: followers,
        followingCount: p.edge_follow?.count ?? null,
        postsCount: p.edge_owner_to_timeline_media?.count ?? null,
        isBusinessAccount: Boolean(p.is_business_account),
        isProfessionalAccount: Boolean(p.is_professional_account),
        businessCategory: p.business_category_name ?? p.category_name ?? null,
        businessEmail: p.business_email || null,
        businessPhone: p.business_phone_number || null,
        businessAddress: p.business_address_json ? (() => { try { const a = JSON.parse(p.business_address_json); return [a.street_address, a.city_name, a.zip_code].filter(Boolean).join(', ') || null; } catch { return null; } })() : null,
        hdProfilePicUrl: p.profile_pic_url_hd ?? null,
        enriched: true,
    };
}
