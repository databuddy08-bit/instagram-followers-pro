// End-to-end tests: runs the real actor (src/main.js) against the local Instagram mock. `npm run test:e2e [scenario...]`
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { startMock } from './mock-instagram.js';

const ROOT = new URL('..', import.meta.url).pathname;
const PRICING = (a = 0.001, b = 0.0025) => JSON.stringify({ pricingModel: 'PAY_PER_EVENT', pricingPerEvent: { actorChargeEvents: { result: { eventPriceUsd: a, eventTitle: 'r' }, 'profile-enrichment': { eventPriceUsd: b, eventTitle: 'e' } } } });
const readDir = (d) => (existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(join(d, f), 'utf8'))) : []);
const COOKIE = 'sessionid=GOOD%3Aabc123; csrftoken=tok; ds_user_id=999';

async function run(name, input, { mock, env = {}, keep = false } = {}) {
    const dir = join(ROOT, 'storage-test', name);
    if (!keep) rmSync(dir, { recursive: true, force: true });
    rmSync(join(dir, 'datasets'), { recursive: true, force: true });
    mkdirSync(join(dir, 'key_value_stores', 'default'), { recursive: true });
    writeFileSync(join(dir, 'key_value_stores', 'default', 'INPUT.json'), JSON.stringify({ sessionCookie: COOKIE, proxyConfiguration: { useApifyProxy: false }, minDelaySec: 1, maxDelaySec: 1, ...input }));
    const t0 = Date.now();
    const child = spawn('node', ['src/main.js'], {
        cwd: ROOT,
        env: { ...process.env, HTTPS_PROXY: '', HTTP_PROXY: '', https_proxy: '', http_proxy: '', CRAWLEE_STORAGE_DIR: dir, APIFY_LOCAL_STORAGE_DIR: dir, CRAWLEE_PURGE_ON_START: '0', IG_BASE: mock.base, HTTP_BACKOFF_SCALE: '0.005',
            ACTOR_TEST_PAY_PER_EVENT: 'true', ACTOR_USE_CHARGING_LOG_DATASET: 'true', APIFY_ACTOR_PRICING_INFO: PRICING(), APIFY_CHARGED_ACTOR_EVENT_COUNTS: '{}', ...env },
    });
    let logs = '';
    child.stdout.on('data', (d) => { logs += d; });
    child.stderr.on('data', (d) => { logs += d; });
    const code = await new Promise((r) => child.on('close', r));
    writeFileSync(join(dir, 'run.log'), logs);
    const rows = readDir(join(dir, 'datasets', 'default'));
    const kv = (k, store = 'default') => (existsSync(join(dir, 'key_value_stores', store, `${k}.json`)) ? JSON.parse(readFileSync(join(dir, 'key_value_stores', store, `${k}.json`), 'utf8')) : null);
    const charges = readDir(join(dir, 'datasets', 'charging_log'));
    const count = (e) => charges.filter((c) => c.eventName === e).reduce((s, c) => s + (c.count ?? 1), 0);
    const ok = rows.filter((r) => !r.error);
    return { code, rows, ok, failed: rows.filter((r) => r.error), results: count('result'), enrich: count('profile-enrichment'), other: charges.filter((c) => !['result', 'profile-enrichment'].includes(c.eventName)).length,
        summary: kv('RUN_SUMMARY'), audience: kv('AUDIENCE_ANALYSIS'), cursors: kv('CURSORS_999', 'instagram-followers-pro-state'), logs, secs: Math.round((Date.now() - t0) / 100) / 10 };
}

const results = [];
const check = (label, pass, detail = '') => {
    results.push(Boolean(pass));
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};
const billed = (r) => r.results === r.ok.length && r.enrich === r.ok.filter((x) => x.enriched).length && r.other === 0;
const only = process.argv.slice(2);
const want = (s) => !only.length || only.includes(s);
const mock = await startMock();

if (want('basic')) {
    console.log('\n=== 1. FOLLOWERS + FOLLOWING, paging, mutuals, overlap, failures ===');
    const r = await run('basic', { usernames: ['bigbrand', 'https://www.instagram.com/smallbrand/', '@privateacct', 'ghost_account_x', 'https://www.instagram.com/p/ABC123/', 'bigbrand'], type: 'both', maxResultsPerProfile: 1000, pageSize: 50 }, { mock });
    const big = r.ok.filter((x) => x.sourceUsername === 'bigbrand');
    check('bigbrand: all 230 followers + 40 following (paged 50 at a time)', r.code === 0 && big.filter((x) => x.type === 'FOLLOWER').length === 230 && big.filter((x) => x.type === 'FOLLOWING').length === 40, `${big.length} rows in ${r.secs}s, ${mock.hits.pages} page requests`);
    check('original fields on every row (sourceUsername, userId, username, fullName, profilePicUrl, isVerified, isPrivate, type)', r.ok.every((x) => x.sourceUsername && x.userId && x.username && typeof x.fullName === 'string' && 'profilePicUrl' in x && typeof x.isVerified === 'boolean' && typeof x.isPrivate === 'boolean' && ['FOLLOWER', 'FOLLOWING'].includes(x.type)));
    check('mutuals flagged on followers (following scraped first and complete)', big.filter((x) => x.type === 'FOLLOWER' && x.isMutual === true).length === 40 && big.filter((x) => x.type === 'FOLLOWER' && x.isMutual === false).length === 190);
    check('low-quality signals (no pic, no name, digit-heavy username)', r.ok.some((x) => x.lowQualitySignals.includes('no_profile_pic')) && r.ok.some((x) => x.lowQualitySignals.includes('no_full_name')) && r.ok.some((x) => x.lowQualitySignals.includes('digit_heavy_username')));
    check('AUDIENCE_ANALYSIS: 10 accounts follow both brands, mutual count 40', r.audience?.overlapAcrossProfiles.count === 10 && r.audience.perList['bigbrand:FOLLOWER'].mutualCount === 40 && r.audience.perList['bigbrand:FOLLOWER'].complete === true, `overlap ${r.audience?.overlapAcrossProfiles.count}`);
    check('private -> "Profile is private", missing -> "Profile does not exist", post URL -> invalid (all free, original error shape)', r.failed.some((f) => f.errorDescription === 'Profile is private' && f.error === 'no_items') && r.failed.some((f) => f.errorDescription === 'Profile does not exist') && r.failed.some((f) => f.status === 'invalid_input') && r.summary.skipReasons.duplicate_input === 1, r.failed.map((f) => f.status).join(','));
    check('every account charged once as "result", nothing else charged', billed(r) && r.results === 305, `${r.results}`);
    check('finished lists leave no resume point', r.cursors && Object.keys(r.cursors).length === 0, JSON.stringify(r.cursors));
}

if (want('resume')) {
    console.log('\n=== 2. LIMITS + RESUME (exact, no repeats, no gaps) ===');
    const a = await run('resume', { usernames: ['bigbrand'], type: 'followers', maxResultsPerProfile: 70, pageSize: 50 }, { mock });
    check('limit 70 -> 70 rows, resume point saved mid-page', a.ok.length === 70 && a.cursors?.['bigbrand:followers']?.cursor === '50' && a.cursors['bigbrand:followers'].skip === 20, JSON.stringify(a.cursors));
    const b = await run('resume', { usernames: ['bigbrand'], type: 'followers', maxResultsPerProfile: 100, pageSize: 50 }, { mock, keep: true });
    const ids = new Set([...a.ok, ...b.ok].map((x) => x.userId));
    check('next run continues at account 71: 100 new, no repeats, no gaps', b.ok.length === 100 && ids.size === 170 && b.ok[0].userId === '1070' && b.summary.perProfile[0].lists[0].resumedFromCursor, `first=${b.ok[0]?.userId}`);
    const c = await run('resume', { usernames: ['bigbrand'], type: 'followers', maxResultsPerProfile: 1000, pageSize: 50 }, { mock, keep: true });
    check('third run finishes the list (60 left) and clears the resume point', c.ok.length === 60 && Object.keys(c.cursors ?? {}).length === 0, `${c.ok.length}`);
    const d = await run('resume', { usernames: ['bigbrand'], type: 'followers', maxResultsPerProfile: 5, resumeFromLastRun: false }, { mock, keep: true });
    check('resume off -> starts from the top', d.ok[0]?.userId === '1000');
}

if (want('safety')) {
    console.log('\n=== 3. ACCOUNT SAFETY STOPS ===');
    const a = await run('challenge', { usernames: ['challengeme', 'bigbrand'], type: 'followers', maxResultsPerProfile: 500, pageSize: 50 }, { mock });
    check('challenge -> stops the WHOLE run at once, keeps data, saves resume point, explains what to do', a.code === 0 && a.ok.length === 50 && !a.ok.some((x) => x.sourceUsername === 'bigbrand') && a.summary.accountSafety?.code === 'challenge' && /confirm it is you/.test(a.summary.accountSafety.message) && a.cursors?.['challengeme:followers']?.cursor === '50' && billed(a), `${a.ok.length} rows, stop=${a.summary.stopReason}`);
    const b = await run('block', { usernames: ['blockme'], type: 'followers', maxResultsPerProfile: 500, pageSize: 50 }, { mock });
    check('"try again later" action block -> safety stop with 24 h advice', b.summary.accountSafety?.code === 'action_block' && /24 hours/.test(b.summary.accountSafety.message) && b.ok.length === 50);
    const c = await run('ratelimit', { usernames: ['slowdown'], type: 'followers' }, { mock });
    check('repeated rate limits -> safety stop (no hammering)', c.summary.accountSafety?.code === 'rate_limited' && mock.pageCalls['slowdown:followers'] <= 3, `${mock.pageCalls['slowdown:followers']} attempts`);
    const d = await run('badcookie', { usernames: ['bigbrand'], sessionCookie: 'sessionid=EXPIRED' }, { mock });
    check('expired cookie -> run fails fast with a clear message', d.code !== 0 && /not logged in/.test(d.logs) && d.ok.length === 0);
    const e = await run('nocookie', { usernames: ['bigbrand'], sessionCookie: '' }, { mock });
    check('missing cookie -> clear message', e.code !== 0 && /session cookie/i.test(e.logs));
    const f = await run('hidden', { usernames: ['hiddenlist', 'friendprivate'], type: 'followers' }, { mock });
    check('hidden list -> free not_allowed row; private profile you follow -> works', f.failed.some((x) => x.status === 'not_allowed') && f.ok.filter((x) => x.sourceUsername === 'friendprivate').length === 12);
    check('cookie never written to the log', !/GOOD%3Aabc123|abc123/.test(a.logs + b.logs + f.logs));
}

if (want('enrich')) {
    console.log('\n=== 4. ENRICHMENT + FILTERS ===');
    const a = await run('enrich', { usernames: ['smallbrand'], type: 'followers', maxResultsPerProfile: 10, enrichProfiles: true }, { mock });
    const biz = a.ok.find((x) => x.isBusinessAccount);
    check('enriched rows: bio, counts, business email/phone/address/category, links', a.ok.length === 10 && a.ok.every((x) => x.enriched && typeof x.followersCount === 'number' && typeof x.postsCount === 'number') && biz?.businessEmail?.endsWith('@example.com') && biz.businessPhone === '+15550100' && biz.businessAddress === '1 Main St, Austin, 73301' && biz.bioLinks.length === 1, JSON.stringify({ e: biz?.businessEmail, c: biz?.businessCategory }));
    check('enrichment charged separately, once per enriched row', billed(a) && a.enrich === 10);
    const b = await run('filters', { usernames: ['bigbrand'], type: 'followers', maxResultsPerProfile: 5, onlyBusiness: true, onlyWithContact: true, minFollowers: 1000, bioKeywords: ['fitness'] }, { mock });
    check('business + contact + min followers + bio keyword (auto-enables enrichment); filtered free', b.ok.length === 5 && b.ok.every((x) => x.isBusinessAccount && x.businessEmail && x.followersCount >= 1000 && /fitness/i.test(x.biography)) && billed(b) && /turning on "Enrich profiles"/.test(b.logs), `${b.ok.length}: ${b.ok.map((x) => x.username)}`);
    const c = await run('basefilters', { usernames: ['bigbrand'], type: 'followers', maxResultsPerProfile: 20, excludePrivate: true, excludeNoProfilePic: true, nameKeywords: ['account 1'] }, { mock });
    check('exclude private + no pic + name keyword (no enrichment needed)', c.ok.length > 0 && c.ok.every((x) => !x.isPrivate && x.hasProfilePic && /account 1/i.test(x.fullName)) && c.enrich === 0, `${c.ok.length}`);
    const d = await run('lowq', { usernames: ['bigbrand'], type: 'followers', maxResultsPerProfile: 30, excludeLowQuality: true }, { mock });
    check('exclude low-quality (2+ signals)', d.ok.length === 30 && d.ok.every((x) => x.lowQualitySignals.length < 2));
    const e = await run('verified', { usernames: ['bigbrand'], type: 'followers', onlyVerified: true, maxResultsPerProfile: 100 }, { mock });
    check('only verified', e.ok.length === 10 && e.ok.every((x) => x.isVerified));
}

if (want('dedupe')) {
    console.log('\n=== 5. ONLY NEW FOLLOWERS (scheduled monitoring) ===');
    const base = { usernames: ['smallbrand'], type: 'followers', skipPreviouslyScraped: true, resumeFromLastRun: false, stateStoreName: 'e2e-state' };
    const a = await run('dedupe', base, { mock });
    const b = await run('dedupe', base, { mock, keep: true });
    check('second run saves nothing already exported (new followers only)', a.ok.length === 30 && b.ok.length === 0 && b.results === 0 && b.summary.skipReasons.seen_in_previous_run === 30);
}

if (want('limits')) {
    console.log('\n=== 6. MAX COST, MAX RESULTS, TIMEOUT ===');
    const a = await run('maxcost', { usernames: ['bigbrand'], type: 'followers', maxResultsPerProfile: 500 }, { mock, env: { ACTOR_MAX_TOTAL_CHARGE_USD: '7', APIFY_ACTOR_PRICING_INFO: PRICING(1, 1) } });
    check('max cost $7 at $1 -> exactly 7, resume point kept', a.ok.length === 7 && a.results === 7 && a.summary.stopReason === 'max_cost_per_run_reached' && a.cursors?.['bigbrand:followers']?.skip === 7, JSON.stringify(a.cursors));
    const b = await run('maxresults', { usernames: ['bigbrand', 'smallbrand'], type: 'followers', maxResults: 60, maxResultsPerProfile: 500 }, { mock });
    check('maxResults 60 across profiles -> exactly 60', b.ok.length === 60 && b.summary.stopReason === 'max_results_reached');
    const slow = await startMock({ delayMs: 300 });
    const c = await run('timeout', { usernames: ['bigbrand'], type: 'followers', maxResultsPerProfile: 1000, pageSize: 12, minDelaySec: 3, maxDelaySec: 3 }, { mock: slow, env: { ACTOR_TIMEOUT_AT: new Date(Date.now() + 60000).toISOString(), HTTP_BACKOFF_SCALE: '1' } });
    check('stops 45 s before timeout; data, summary and resume point saved', c.code === 0 && c.ok.length > 0 && c.ok.length < 230 && /timeout_approaching/.test(c.summary?.stopReason ?? '') && c.cursors?.['bigbrand:followers'] && c.secs < 60, `${c.ok.length} in ${c.secs}s`);
    slow.close();
}

mock.close();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
