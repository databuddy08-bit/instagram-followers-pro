# Instagram Followers & Following Pro: Resume, Enrichment, Mutuals & Audience Quality

Export the **followers and following lists** of Instagram profiles, built to protect the account you use. Each run can:
- continue big lists **exactly where the last run stopped**;
- **enrich** each account with bio, follower counts and **business email, phone and address**;
- filter by verified, private, keywords, follower range or business status;
- flag **mutual followers**;
- find the **audience overlap** between profiles;
- flag **low-quality and inactive** accounts for influencer vetting.

**From $1.00 per 1,000 accounts. Filtered accounts and failed inputs are never charged.**

> **Why a session cookie?** Instagram shows follower lists **only to logged-in accounts**. Checked in October 2026, every logged-out route returns `"require_login": true`. Store actors that claim "no login" log in behind the scenes with their own pools of accounts. This actor uses **your** session, transparently, with safety built in. Use a **secondary account**, not your main one.

## How to get your session cookie (2 minutes)

1. Log in to **instagram.com** in Chrome or Edge with the account you want to use. A secondary account is best.
2. Press **F12** to open Developer Tools, then go to **Application → Cookies → https://www.instagram.com**.
3. Find **`sessionid`** and copy its **Value**.
4. Paste it into **"Your Instagram session cookie"**. You can also paste the whole cookie, or a JSON export from a cookie extension.

The field is a secret input. Apify stores it encrypted, and the actor never writes it to the log. If you log out of Instagram in that browser, the cookie stops working; just copy a new one.

## Built-in account safety

| What Instagram watches | What this actor does |
|---|---|
| A session hopping between IPs | **One sticky IP for the whole run**. It never rotates. |
| Bursts of requests | **One request at a time**, with random 3–6 second pauses (adjustable) |
| Security checks ("confirm it's you") | **Stops the whole run immediately**, keeps the data, and tells you what to do |
| "Try again later" action blocks | Stops immediately and advises a 24-hour break |
| Repeated rate limits | Backs off, then stops instead of hammering. The next run resumes. |
| Expired login | Fails at the first request with a clear message, before anything is charged |

**Guidelines:**
- Use a secondary account.
- Set the proxy country to where you normally use that account.
- Keep to a few thousand accounts per day per Instagram account.
- Turn on enrichment only when you need it. It makes one extra request per account.

## What you get

**Same fields as Apify's Instagram Followers & Following Scraper:** `sourceUsername`, `userId`, `username`, `fullName`, `profilePicUrl`, `isVerified`, `isPrivate`, `type` (`FOLLOWER` or `FOLLOWING`).

**Plus:**
- `isMutual`: the profile also follows this follower. Filled in when you choose "Both".
- `lowQualitySignals`: for example `no_profile_pic`, `no_full_name`, `digit_heavy_username`. With enrichment it can also show `no_posts`, `no_bio` and `follows_far_more_than_followers`. These are signals, not verdicts.
- `hasActiveStory`, `hasProfilePic`, `profileUrl`, `position`, `sourceUserId`.
- With enrichment: `biography`, `externalUrl`, `bioLinks`, `followersCount`, `followingCount`, `postsCount`, `isBusinessAccount`, `businessCategory`, `businessEmail`, `businessPhone`, `businessAddress`.

**`AUDIENCE_ANALYSIS`** (key-value store) contains:
- **overlap across profiles:** accounts that follow two or more of the profiles you scraped (shared audience);
- the **mutual count** for each list;
- the verified share of each list;
- whether each list was read completely.

## How it is better than the original

| | Original | Pro |
|---|---|---|
| Price | from $1.15 / 1,000 | **$1.00 / 1,000** |
| Huge lists over several runs | Start over each time | ✅ **Exact resume**: no repeats, no gaps |
| Only new followers since last run | — | ✅ |
| Mutual followers | — | ✅ `isMutual` |
| Audience overlap between creators | Manual work | ✅ `AUDIENCE_ANALYSIS` |
| Fake or inactive follower signals | — | ✅ `lowQualitySignals` and a filter |
| Bio, counts, business email, phone and address | Separate actor | ✅ Optional enrichment |
| Filters: verified, private, no picture, name, bio, follower range, business, has contact | — | ✅ Filtered accounts are free |
| Safety stops and a resume point when Instagram pushes back | — | ✅ |

## Pricing (pay per event)

| Event | When | Price |
|---|---|---|
| `result` | One follower or following account saved | $0.001 ($1.00 per 1,000) |
| `profile-enrichment` | That account's full profile added | $0.0025 |

The run stops cleanly at your **Maximum cost per run** and saves the resume point.

## Example inputs

**Sample an influencer's audience quality:**
```json
{ "sessionCookie": "…", "usernames": ["some_creator"], "type": "followers", "maxResultsPerProfile": 1000 }
```

**Lead list: business followers of a competitor with an email:**
```json
{ "sessionCookie": "…", "usernames": ["competitor"], "type": "followers", "maxResultsPerProfile": 200, "onlyWithContact": true, "onlyBusiness": true }
```

**Daily new-follower monitoring** (schedule it):
```json
{ "sessionCookie": "…", "usernames": ["your_brand"], "type": "followers", "maxResultsPerProfile": 300, "skipPreviouslyScraped": true, "resumeFromLastRun": false }
```

## Errors (free rows, same shape as the original)

`{"error": "no_items", "errorDescription": "Profile is private"}` (or `"Profile does not exist"`), plus `status`, `inputUrl` and `fixHint`. The possible statuses are `private`, `not_found`, `not_allowed` (hidden list) and `invalid_input`. Account safety stops are explained in `RUN_SUMMARY → accountSafety` and in the run's status message.

## Legal

Follower lists are personal data under the GDPR and similar laws. Use them only with a legitimate purpose, keep just the fields you need, and respect Instagram's terms. You are responsible for the account and session you provide.
