import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCookie, parseProfileInput, qualitySignals, listRow, enrichment } from '../src/instagram.js';

test('cookie: header string, browser JSON export, bare sessionid; ds_user_id derived', () => {
    const a = parseCookie('sessionid=123456%3AabcDEF%3A12; csrftoken=tok; mid=xyz');
    assert.equal(a.sessionid, '123456%3AabcDEF%3A12');
    assert.equal(a.csrftoken, 'tok');
    assert.equal(a.dsUserId, '123456');
    assert.match(a.header, /sessionid=123456%3AabcDEF%3A12; csrftoken=tok; mid=xyz; ds_user_id=123456/);
    const b = parseCookie('[{"name":"sessionid","value":"777%3Aq%3A1","domain":".instagram.com"},{"name":"csrftoken","value":"c"}]');
    assert.equal(b.dsUserId, '777');
    assert.equal(b.csrftoken, 'c');
    const c = parseCookie('888%3Azzz%3A9');
    assert.equal(c.header, 'sessionid=888%3Azzz%3A9; ds_user_id=888');
    assert.equal(parseCookie('Cookie: sessionid=1%3Ax; ds_user_id=1').dsUserId, '1');
    assert.throws(() => parseCookie(''), /session cookie/);
    assert.throws(() => parseCookie('csrftoken=abc'), /No "sessionid"/);
    assert.throws(() => parseCookie('[{oops'), /JSON/);
});

test('profile input: usernames, @handles, URLs incl. /followers/, rejects posts and other sites', () => {
    assert.deepEqual(parseProfileInput('NatGeo'), { username: 'natgeo', input: 'NatGeo' });
    assert.equal(parseProfileInput('@nasa').username, 'nasa');
    assert.equal(parseProfileInput('https://www.instagram.com/natgeo/?hl=en').username, 'natgeo');
    assert.equal(parseProfileInput('instagram.com/natgeo/following/').list, 'following');
    assert.ok(parseProfileInput('https://www.instagram.com/p/ABC123/').invalid);
    assert.ok(parseProfileInput('https://tiktok.com/@x').invalid);
    assert.equal(parseProfileInput('  '), null);
});

test('rows: original field names + additions; quality signals are signals, not verdicts', () => {
    const u = { pk: 42, username: 'jane_doe1999_2024', full_name: '', is_private: true, is_verified: false, profile_pic_url: 'https://x/44884218_345707102882519_2446069589734326272_n.jpg', has_anonymous_profile_picture: true, latest_reel_media: 0 };
    const r = listRow(u, { username: 'natgeo', userId: '787132' }, 'FOLLOWER', 3);
    assert.deepEqual(Object.keys(r).slice(0, 8), ['sourceUsername', 'userId', 'username', 'fullName', 'profilePicUrl', 'isVerified', 'isPrivate', 'type']);
    assert.equal(r.userId, '42');
    assert.equal(r.hasProfilePic, false);
    assert.equal(r.profileUrl, 'https://www.instagram.com/jane_doe1999_2024/');
    assert.deepEqual(qualitySignals(u), ['no_profile_pic', 'no_full_name', 'digit_heavy_username']);
    assert.deepEqual(qualitySignals({ username: 'ok', full_name: 'Ok', profile_pic_url: 'https://x/1.jpg' }, { edge_owner_to_timeline_media: { count: 0 }, edge_followed_by: { count: 10 }, edge_follow: { count: 5000 }, biography: '' }), ['no_posts', 'follows_far_more_than_followers', 'no_bio']);
});

test('enrichment fields', () => {
    const e = enrichment({ biography: 'Hi', external_url: 'https://a.b', bio_links: [{ url: 'https://l.ink' }], edge_followed_by: { count: 5 }, edge_follow: { count: 6 }, edge_owner_to_timeline_media: { count: 7 }, is_business_account: true, business_category_name: 'Cafe', business_email: 'x@y.z', business_phone_number: '+1', business_address_json: '{"street_address":"1 A St","city_name":"Pune","zip_code":"411001"}' });
    assert.equal(e.followersCount, 5);
    assert.equal(e.businessEmail, 'x@y.z');
    assert.equal(e.businessAddress, '1 A St, Pune, 411001');
    assert.deepEqual(e.bioLinks, ['https://l.ink']);
    assert.equal(enrichment({ business_email: '', business_phone_number: '' }).businessEmail, null);
});
