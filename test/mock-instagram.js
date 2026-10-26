// Local stand-in for the logged-in Instagram web API: current_user, web_profile_info, friendships followers/following
// with max_id paging, private profiles, challenge / action-block / rate-limit answers.
import http from 'node:http';

const PROFILES = {
    bigbrand: { id: '111', followers: 230, following: 40 },
    smallbrand: { id: '222', followers: 30, following: 5 },
    privateacct: { id: '333', followers: 50, following: 50, private: true },
    friendprivate: { id: '444', followers: 12, following: 3, private: true, followedByViewer: true },
    challengeme: { id: '555', followers: 300, following: 0, challengeAfter: 1 },
    blockme: { id: '666', followers: 300, following: 0, blockAfter: 1 },
    slowdown: { id: '777', followers: 300, following: 0, rateLimitAlways: true },
    hiddenlist: { id: '888', followers: 100, following: 0, hidden: true },
};
const byId = Object.fromEntries(Object.entries(PROFILES).map(([u, p]) => [p.id, { ...p, username: u }]));

/** Account n of the shared pool. bigbrand followers = 0..229, smallbrand followers = 220..249 (10 overlap), bigbrand following = 0..39 (all mutual). */
function account(n) {
    return {
        pk: String(1000 + n), pk_id: String(1000 + n), username: n % 7 === 3 ? `user${n}${n}2024` : `acct_${n}`, full_name: n % 6 === 5 ? '' : `Account ${n}`,
        is_private: n % 4 === 1, is_verified: n % 25 === 0, profile_pic_url: n % 8 === 7 ? 'https://scontent.cdninstagram.com/v/t51.2885-19/44884218_345707102882519_2446069589734326272_n.jpg' : `https://scontent.cdninstagram.com/v/${n}.jpg`,
        has_anonymous_profile_picture: n % 8 === 7, latest_reel_media: n % 3 === 0 ? 1790000000 : 0,
    };
}
const listOf = (p, which) => {
    if (p.username === 'bigbrand') return which === 'followers' ? range(0, 230) : range(0, 40);
    if (p.username === 'smallbrand') return which === 'followers' ? range(220, 250) : range(500, 505);
    return which === 'followers' ? range(1000, 1000 + p.followers) : range(2000, 2000 + p.following);
};
const range = (a, b) => Array.from({ length: b - a }, (_, i) => a + i);

function profileJson(username) {
    const p = PROFILES[username];
    if (p) return { id: p.id, username, full_name: username.toUpperCase(), is_private: Boolean(p.private), followed_by_viewer: Boolean(p.followedByViewer), edge_followed_by: { count: p.followers }, edge_follow: { count: p.following }, edge_owner_to_timeline_media: { count: 100 }, biography: 'Brand page' };
    const m = username.match(/^acct_(\d+)$|^user(\d+)\2?2024$/);
    const n = m ? Number(m[1] ?? m[2]) : null;
    if (n === null) return null;
    const biz = n % 5 === 0;
    return {
        id: String(1000 + n), username, full_name: `Account ${n}`, is_private: n % 4 === 1, biography: n % 10 === 9 ? '' : `Coffee lover ☕ | ${biz ? 'Fitness coach' : 'Traveller'} #${n}`, external_url: biz ? `https://site${n}.example.com` : null,
        bio_links: biz ? [{ url: `https://linktr.ee/acct${n}` }] : [], edge_followed_by: { count: n * 100 }, edge_follow: { count: n === 2 ? 5000 : 150 }, edge_owner_to_timeline_media: { count: n % 11 === 10 ? 0 : 42 },
        is_business_account: biz, is_professional_account: biz, business_category_name: biz ? 'Fitness Trainer' : null, business_email: biz ? `hello${n}@example.com` : '', business_phone_number: biz ? '+15550100' : '',
        business_address_json: biz ? JSON.stringify({ street_address: '1 Main St', city_name: 'Austin', zip_code: '73301' }) : null, profile_pic_url_hd: `https://scontent.cdninstagram.com/v/${n}_hd.jpg`,
    };
}

export async function startMock({ delayMs = 0 } = {}) {
    const hits = { pages: 0, profiles: 0, sawProxy: 0 };
    const pageCalls = {};
    const send = (res, code, body, headers = {}) => {
        res.writeHead(code, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(body));
    };
    const server = http.createServer(async (req, res) => {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        const u = new URL(req.url, 'http://x');
        const cookie = req.headers.cookie ?? '';
        if (!/sessionid=GOOD/.test(cookie) || req.headers['x-ig-app-id'] !== '936619743392459') return send(res, 401, { message: 'Please wait a few minutes before you try again.', require_login: true, status: 'fail' });
        if (u.pathname === '/api/v1/accounts/current_user/') return send(res, 200, { user: { username: 'tester_account', pk: '999' }, status: 'ok' });
        if (u.pathname === '/api/v1/users/web_profile_info/') {
            hits.profiles += 1;
            const p = profileJson(u.searchParams.get('username'));
            return p ? send(res, 200, { data: { user: p }, status: 'ok' }) : send(res, 404, { data: { user: null }, status: 'fail' });
        }
        const m = u.pathname.match(/^\/api\/v1\/friendships\/(\d+)\/(followers|following)\/$/);
        if (m) {
            hits.pages += 1;
            const p = byId[m[1]];
            if (!p) return send(res, 404, { message: 'User not found', status: 'fail' });
            const k = `${p.username}:${m[2]}`;
            pageCalls[k] = (pageCalls[k] ?? 0) + 1;
            if (p.private && !p.followedByViewer) return send(res, 400, { message: 'Not authorized to view user', status: 'fail' });
            if (p.hidden) return send(res, 403, { message: 'Not authorized to view user', status: 'fail' });
            if (p.challengeAfter && pageCalls[k] > p.challengeAfter) return send(res, 400, { message: 'challenge_required', checkpoint_url: '/challenge/abc/', status: 'fail' });
            if (p.blockAfter && pageCalls[k] > p.blockAfter) return send(res, 400, { message: 'feedback_required', feedback_title: 'Try Again Later', spam: true, status: 'fail' });
            if (p.rateLimitAlways) return send(res, 429, { message: 'Please wait a few minutes before you try again.', status: 'fail' });
            const all = listOf(p, m[2]);
            const start = Number(u.searchParams.get('max_id') ?? 0);
            const count = Number(u.searchParams.get('count') ?? 12);
            const slice = all.slice(start, start + count);
            return send(res, 200, { users: slice.map(account), big_list: start + count < all.length, page_size: count, next_max_id: start + count < all.length ? String(start + count) : null, status: 'ok' });
        }
        return send(res, 404, { message: 'not found', status: 'fail' });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ base: `http://127.0.0.1:${server.address().port}`, hits, pageCalls, close: () => server.close() })));
}
