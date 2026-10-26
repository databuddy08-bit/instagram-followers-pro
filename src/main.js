// Instagram Followers & Following Pro — Apify actor entry point. Uses the user's own session; built to protect that account.
import { Actor, log } from 'apify';
import { makeInstagram, parseCookie, parseProfileInput, listRow, enrichment, qualitySignals, AccountStop, StoppedError } from './instagram.js';

// Pay-per-event names — must match the Monetization settings exactly.
export const EVENT_RESULT = 'result'; // one follower / following account
export const EVENT_ENRICH = 'profile-enrichment'; // full profile added to that account (bio, counts, business contacts)

const STOP_BEFORE_TIMEOUT_MS = 45000;
const PROGRESS_EVERY = 100;

await Actor.init();
const input = (await Actor.getInput()) ?? {};
const num = (v, d, min, max) => Math.min(max, Math.max(min, Number.isFinite(Number(v)) && v !== '' && v !== null ? Number(v) : d));
const list = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\n,]/) : []).map((x) => String(typeof x === 'object' && x ? x.url ?? x.username ?? '' : x).trim()).filter(Boolean);
const opts = {
    usernames: list(input.usernames),
    type: ['followers', 'following', 'both'].includes(input.type) ? input.type : 'followers',
    maxResultsPerProfile: num(input.maxResultsPerProfile, 500, 1, 1e7),
    maxResults: num(input.maxResults, 0, 0, 1e8),
    pageSize: num(input.pageSize, 50, 12, 100),
    enrichProfiles: Boolean(input.enrichProfiles),
    onlyVerified: Boolean(input.onlyVerified),
    excludePrivate: Boolean(input.excludePrivate),
    excludeNoProfilePic: Boolean(input.excludeNoProfilePic),
    excludeLowQuality: Boolean(input.excludeLowQuality),
    nameKeywords: list(input.nameKeywords).map((k) => k.toLowerCase()),
    bioKeywords: list(input.bioKeywords).map((k) => k.toLowerCase()),
    minFollowers: num(input.minFollowers, 0, 0, 1e10),
    maxFollowers: num(input.maxFollowers, 0, 0, 1e10),
    onlyBusiness: Boolean(input.onlyBusiness),
    onlyWithContact: Boolean(input.onlyWithContact),
    resumeFromLastRun: input.resumeFromLastRun !== false,
    skipPreviouslyScraped: Boolean(input.skipPreviouslyScraped),
    stateStoreName: /^[a-z0-9-]{1,63}$/.test(input.stateStoreName ?? '') ? input.stateStoreName : 'instagram-followers-pro-state',
    pace: { page: [num(input.minDelaySec, 3, 1, 120), num(input.maxDelaySec, 6, 1, 300)], profile: [num(input.minDelaySec, 3, 1, 120) + 1, num(input.maxDelaySec, 6, 1, 300) + 2] },
};
if (opts.pace.page[1] < opts.pace.page[0]) opts.pace.page[1] = opts.pace.page[0];
const needsEnrichment = opts.bioKeywords.length || opts.minFollowers || opts.maxFollowers || opts.onlyBusiness || opts.onlyWithContact;
if (needsEnrichment && !opts.enrichProfiles) {
    log.warning('Bio / follower-count / business filters need profile details — turning on "Enrich profiles" for this run.');
    opts.enrichProfiles = true;
}
let cookie;
try {
    cookie = parseCookie(input.sessionCookie);
} catch (err) {
    await Actor.fail(err.message);
}
if (!opts.usernames.length) await Actor.fail('Add at least one Instagram username or profile URL.');

// ---------- Deadline, proxy, pricing ----------
const startedAt = Date.now();
const { timeoutAt } = Actor.getEnv();
const deadline = timeoutAt ? new Date(timeoutAt).getTime() - STOP_BEFORE_TIMEOUT_MS : Infinity;
let stopReason = null;
const stop = (r) => {
    if (!stopReason) {
        stopReason = r;
        log.info(`Stopping: ${r}`);
    }
};
const msLeft = () => {
    if (!stopReason && Date.now() >= deadline) stop('timeout_approaching (stopped 45 s early so data and resume point are saved)');
    return stopReason ? 0 : deadline - Date.now();
};
let proxyConfiguration;
try {
    proxyConfiguration = await Actor.createProxyConfiguration(input.proxyConfiguration);
} catch (err) {
    log.warning(`Proxy could not be configured (${err.message}). Continuing without it.`);
}
log.info(`Network: ${proxyConfiguration ? 'one sticky proxy IP for the whole run' : 'server IP'} — the session never changes IP mid-run (that is what triggers Instagram checks).`);
const charging = Actor.getChargingManager();
const pricing = charging.getPricingInfo();
const canCharge = (e) => !pricing.isPayPerEvent || charging.calculateMaxEventChargeCountWithinLimit(e) > 0;

const summary = {
    startedAt: new Date(startedAt).toISOString(), finishedAt: null, durationSec: null, stopReason: null, loggedInAs: null,
    saved: 0, enriched: 0, failedRowsSaved: 0, chargedEvents: { [EVENT_RESULT]: 0, [EVENT_ENRICH]: 0 }, statusCounts: {}, skipReasons: {}, perProfile: [],
    requests: { requests: 0, rateLimited: 0, networkErrors: 0 }, accountSafety: null,
};
const bump = (o, k, n = 1) => { o[k] = (o[k] ?? 0) + n; };
const ig = makeInstagram({ cookie, proxyConfiguration, msLeft, stats: summary.requests, pace: opts.pace });

const state = await Actor.openKeyValueStore(opts.stateStoreName);
const ownerKey = cookie.dsUserId ?? 'anon';
const cursors = (await state.getValue(`CURSORS_${ownerKey}`)) ?? {};
const seenPrevRaw = opts.skipPreviouslyScraped ? (await state.getValue(`SEEN_${ownerKey}`)) ?? {} : {};
const seenPrev = Object.fromEntries(Object.entries(seenPrevRaw).map(([k, v]) => [k, new Set(v)]));
const saveState = async () => {
    await state.setValue(`CURSORS_${ownerKey}`, cursors);
    if (opts.skipPreviouslyScraped) await state.setValue(`SEEN_${ownerKey}`, Object.fromEntries(Object.entries(seenPrev).map(([k, v]) => [k, [...v]])));
};

// ---------- Output ----------
let chain = Promise.resolve();
const FIX = {
    invalid_input: 'Use an Instagram username (natgeo) or a profile URL (instagram.com/natgeo).',
    not_found: 'No Instagram account with this username. Check the spelling (usernames can change).',
    private: 'The profile is private and the logged-in account does not follow it. Only lists you can see in the app can be exported.',
    not_allowed: 'Instagram did not show this list to the logged-in account (private profile, or the owner hid the list).',
    error: 'Unexpected error. Run again; if it repeats, send the run log to the developer.',
};
function saveFailed(inputValue, status, description, extra = {}) {
    bump(summary.statusCounts, status);
    chain = chain.then(async () => {
        await Actor.pushData({ error: 'no_items', errorDescription: description, status, inputUrl: inputValue, ...extra, fixHint: FIX[status] ?? FIX.error, scrapedAt: new Date().toISOString() }); // never charged
        summary.failedRowsSaved += 1;
    });
    return chain;
}
function save(row) {
    const p = chain.then(async () => {
        if (stopReason) return false;
        if (opts.maxResults && summary.saved >= opts.maxResults) {
            stop('max_results_reached');
            return false;
        }
        if (!canCharge(EVENT_RESULT) || (row.enriched && !canCharge(EVENT_ENRICH))) {
            stop('max_cost_per_run_reached');
            return false;
        }
        row.scrapedAt = new Date().toISOString();
        const res = await Actor.pushData(row, EVENT_RESULT);
        summary.saved += 1;
        summary.chargedEvents[EVENT_RESULT] += res?.chargedCount ?? 0;
        if (row.enriched) {
            const e = await charging.charge({ eventName: EVENT_ENRICH });
            summary.enriched += 1;
            summary.chargedEvents[EVENT_ENRICH] += e?.chargedCount ?? 0;
            if (e?.eventChargeLimitReached) stop('max_cost_per_run_reached');
        }
        bump(summary.statusCounts, 'ok');
        if (res?.eventChargeLimitReached) stop('max_cost_per_run_reached');
        if (opts.maxResults && summary.saved >= opts.maxResults) stop('max_results_reached');
        if (summary.saved % PROGRESS_EVERY === 0) {
            const min = Math.max((Date.now() - startedAt) / 60000, 1 / 60);
            log.info(`Progress: ${summary.saved} accounts saved, ${Math.round(summary.saved / min)}/min (paced to protect the account).`);
        }
        return true;
    });
    chain = p.then(() => {}, () => {});
    return p;
}

// ---------- Audience analysis (overlap across profiles, mutuals) ----------
const audience = new Map(); // userId -> {username, in: Set("source:type")}
const lists = {}; // "source:type" -> {ids:Set, complete:boolean}
function track(row) {
    const key = `${row.sourceUsername}:${row.type}`;
    const a = audience.get(row.userId) ?? { username: row.username, fullName: row.fullName, isVerified: row.isVerified, in: new Set() };
    a.in.add(key);
    audience.set(row.userId, a);
}

// ---------- Filters (filtered accounts are never charged) ----------
function baseSkip(row, seenKey) {
    if (lists[seenKey]?.ids.has(row.userId)) return 'duplicate_in_list';
    if (seenPrev[seenKey]?.has(row.userId)) return 'seen_in_previous_run';
    if (opts.onlyVerified && !row.isVerified) return 'filtered_not_verified';
    if (opts.excludePrivate && row.isPrivate) return 'filtered_private';
    if (opts.excludeNoProfilePic && !row.hasProfilePic) return 'filtered_no_profile_pic';
    if (opts.nameKeywords.length && !opts.nameKeywords.some((k) => `${row.username} ${row.fullName}`.toLowerCase().includes(k))) return 'filtered_name_keywords';
    return null;
}
function enrichedSkip(row) {
    if (opts.minFollowers && (row.followersCount ?? 0) < opts.minFollowers) return 'filtered_min_followers';
    if (opts.maxFollowers && (row.followersCount ?? Infinity) > opts.maxFollowers) return 'filtered_max_followers';
    if (opts.onlyBusiness && !row.isBusinessAccount && !row.isProfessionalAccount) return 'filtered_not_business';
    if (opts.onlyWithContact && !row.businessEmail && !row.businessPhone && !row.externalUrl) return 'filtered_no_contact';
    if (opts.bioKeywords.length && !opts.bioKeywords.some((k) => `${row.biography} ${row.businessCategory ?? ''}`.toLowerCase().includes(k))) return 'filtered_bio_keywords';
    return null;
}

// ---------- One list ----------
async function scrapeList(src, which, rec) {
    const type = which === 'followers' ? 'FOLLOWER' : 'FOLLOWING';
    const key = `${src.username}:${type}`;
    const cursorKey = `${src.username}:${which}`;
    lists[key] = lists[key] ?? { ids: new Set(), complete: false };
    seenPrev[key] = seenPrev[key] ?? new Set();
    const lr = { list: which, saved: 0, seen: 0, pages: 0, resumedFromCursor: false, complete: false, skipped: {} };
    rec.lists.push(lr);
    const saved0 = opts.resumeFromLastRun ? cursors[cursorKey] : null;
    let cursor = typeof saved0 === 'string' ? saved0 : saved0?.cursor ?? null;
    let skip = typeof saved0 === 'object' && saved0 ? saved0.skip ?? 0 : 0;
    if (saved0) {
        lr.resumedFromCursor = true;
        log.info(`@${src.username} ${which}: resuming where the last run stopped.`);
    }
    let position = 0;
    while (lr.saved < opts.maxResultsPerProfile && !stopReason) {
        let page;
        try {
            page = await ig.listPage(src.userId, src.username, which, cursor, opts.pageSize);
        } catch (err) {
            if (err instanceof AccountStop || err instanceof StoppedError) {
                cursors[cursorKey] = { cursor, skip };
                await saveState();
                throw err;
            }
            if (err.notAllowed) {
                await saveFailed(src.input, 'not_allowed', err.message, { sourceUsername: src.username, type });
                return;
            }
            throw err;
        }
        lr.pages += 1;
        let handled = 0; // users of this page fully dealt with (saved or skipped)
        let interrupted = false;
        for (const u of page.users) {
            if (handled < skip) {
                handled += 1;
                continue;
            }
            let outcome;
            try {
                outcome = await handleUser(u, src, type, key, ++position, lr);
            } catch (err) {
                if (err instanceof AccountStop || err instanceof StoppedError) { // safety stop mid-page: resume at this account
                    cursors[cursorKey] = { cursor, skip: handled };
                    await saveState();
                }
                throw err;
            }
            if (outcome === 'stop') {
                interrupted = true;
                break;
            }
            handled += 1;
            if (lr.saved >= opts.maxResultsPerProfile) {
                interrupted = handled < page.users.length;
                break;
            }
        }
        skip = 0;
        if (interrupted) { // continue inside this page next time, right after the last handled account
            cursors[cursorKey] = { cursor, skip: handled };
            await saveState();
            return;
        }
        if (!page.next || !page.users.length) {
            lr.complete = true;
            lists[key].complete = true;
            delete cursors[cursorKey];
            await saveState();
            return;
        }
        cursor = page.next;
        cursors[cursorKey] = { cursor, skip: 0 };
        await saveState();
    }
}

/** Builds, filters, enriches and saves one account. Returns 'saved' | 'skipped' | 'stop'. */
async function handleUser(u, src, type, key, position, lr) {
    const row = listRow(u, src, type, position);
    lr.seen += 1;
    if (!row.userId || !row.username) return 'skipped';
    const reason = baseSkip(row, key);
    lists[key].ids.add(row.userId);
    track(row);
    if (reason) {
        bump(summary.skipReasons, reason);
        bump(lr.skipped, reason);
        return 'skipped';
    }
    let prof = null;
    if (opts.enrichProfiles) {
        if (!canCharge(EVENT_ENRICH)) {
            stop('max_cost_per_run_reached');
            return 'stop';
        }
        try {
            prof = await ig.profile(row.username);
        } catch (err) {
            if (err instanceof AccountStop || err instanceof StoppedError) throw err;
            row.enrichmentError = err.message;
        }
        if (prof) Object.assign(row, enrichment(prof));
        const er = prof ? enrichedSkip(row) : null;
        if (er) {
            bump(summary.skipReasons, er);
            bump(lr.skipped, er);
            return 'skipped';
        }
    }
    row.lowQualitySignals = qualitySignals(u, prof);
    if (opts.excludeLowQuality && row.lowQualitySignals.length >= 2) {
        bump(summary.skipReasons, 'filtered_low_quality');
        bump(lr.skipped, 'filtered_low_quality');
        return 'skipped';
    }
    if (type === 'FOLLOWER') {
        const f = lists[`${src.username}:FOLLOWING`];
        row.isMutual = f ? (f.ids.has(row.userId) ? true : f.complete ? false : null) : null;
    } else row.isMutual = null;
    const ok = await save(row);
    if (!ok) return 'stop';
    seenPrev[key].add(row.userId);
    lr.saved += 1;
    return 'saved';
}

// ---------- Run ----------
let viewer = null;
try {
    viewer = await ig.whoAmI();
    summary.loggedInAs = `${viewer.username.slice(0, 2)}***`;
    log.info(`Logged in as @${viewer.username.slice(0, 2)}*** — scraping ${opts.usernames.length} profile(s): ${opts.type}, up to ${opts.maxResultsPerProfile} per list, ${opts.pace.page[0]}–${opts.pace.page[1]} s between pages${opts.enrichProfiles ? ', with profile enrichment (slower)' : ''}.`);
} catch (err) {
    summary.accountSafety = { code: err.code ?? 'error', message: err.message };
    await Actor.setValue('RUN_SUMMARY', summary);
    await Actor.fail(err.message);
}

const seenInputs = new Set();
for (const raw of opts.usernames) {
    if (stopReason) break;
    const t = parseProfileInput(raw);
    if (!t) continue;
    if (t.invalid) {
        await saveFailed(t.input, 'invalid_input', t.error);
        continue;
    }
    if (seenInputs.has(t.username)) {
        bump(summary.skipReasons, 'duplicate_input');
        continue;
    }
    seenInputs.add(t.username);
    const rec = { username: t.username, lists: [], profile: null, error: null };
    summary.perProfile.push(rec);
    try {
        const p = await ig.profile(t.username);
        if (!p) {
            await saveFailed(t.input, 'not_found', 'Profile does not exist');
            continue;
        }
        rec.profile = { userId: String(p.id), followers: p.edge_followed_by?.count ?? null, following: p.edge_follow?.count ?? null, isPrivate: Boolean(p.is_private) };
        if (p.is_private && !p.followed_by_viewer && String(p.id) !== viewer.pk) {
            await saveFailed(t.input, 'private', 'Profile is private');
            continue;
        }
        const src = { username: t.username, userId: String(p.id), input: t.input };
        const which = t.list ? [t.list] : opts.type === 'both' ? ['following', 'followers'] : [opts.type]; // following first, so followers get "isMutual"
        for (const w of which) {
            if (stopReason) break;
            await scrapeList(src, w, rec);
        }
    } catch (err) {
        if (err instanceof StoppedError) break;
        if (err instanceof AccountStop) {
            summary.accountSafety = { code: err.code, message: err.message };
            log.error(`ACCOUNT SAFETY STOP: ${err.message}`);
            stop(`account_safety_${err.code}`);
            break;
        }
        rec.error = err.message;
        log.exception(err, `@${t.username}`);
        await saveFailed(t.input, 'error', err.message);
    }
}
await chain;

// ---------- Summary + audience analysis ----------
const perSource = {};
for (const [key, l] of Object.entries(lists)) {
    const ids = [...l.ids];
    const accs = ids.map((id) => audience.get(id)).filter(Boolean);
    const followersKey = key.endsWith(':FOLLOWER') ? key : null;
    const followingIds = followersKey ? lists[key.replace(':FOLLOWER', ':FOLLOWING')]?.ids : null;
    perSource[key] = {
        accountsSeen: ids.length, complete: l.complete,
        verifiedPercent: ids.length ? Math.round((accs.filter((a) => a.isVerified).length / ids.length) * 1000) / 10 : null,
        mutualCount: followingIds ? ids.filter((id) => followingIds.has(id)).length : null,
    };
}
const overlap = [...audience.entries()].filter(([, a]) => new Set([...a.in].map((k) => k.split(':')[0])).size >= 2).map(([id, a]) => ({ userId: id, username: a.username, fullName: a.fullName, foundIn: [...a.in] })).slice(0, 50000);
await Actor.setValue('AUDIENCE_ANALYSIS', { generatedAt: new Date().toISOString(), note: 'Counts cover the accounts this run looked at (including filtered ones), not the full lists unless "complete" is true.', perList: perSource, overlapAcrossProfiles: { count: overlap.length, accounts: overlap } });
await saveState();
summary.stopReason = stopReason ?? 'completed';
summary.finishedAt = new Date().toISOString();
summary.durationSec = Math.round((Date.now() - startedAt) / 1000);
await Actor.setValue('RUN_SUMMARY', summary);
const resumable = Object.keys(cursors).length;
const msg = `Saved ${summary.saved} accounts${summary.enriched ? ` (${summary.enriched} enriched)` : ''}. ${summary.failedRowsSaved} inputs without results (not charged).${resumable ? ` ${resumable} list(s) can be resumed by the next run.` : ''} Stop reason: ${summary.stopReason}.`;
log.info(msg);
if (summary.accountSafety) await Actor.exit({ statusMessage: `${msg} — ${summary.accountSafety.message}` });
else await Actor.exit({ statusMessage: msg });
