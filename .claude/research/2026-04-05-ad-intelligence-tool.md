# Ad Intelligence Tool — Research Brief
_Compiled 2026-04-05 for tomorrow's kickoff_

---

## The Idea
Facebook Ad Library analysis tool — find trending ads by category, track what's working, and later add funnel analysis (ad -> landing page -> checkout flow).

---

## Facebook Ad Library API

### What you get
- Ad creative text, snapshot URLs, page names, platforms, start/stop dates, estimated audience size
- Political/social ads: spend ranges, impressions, demographics, regional delivery
- EU ads (DSA compliance): age/gender targeting, location targeting, beneficiary info

### What you DON'T get
- **No spend/impressions for commercial ads** (only political/social)
- No targeting details (interests, behaviors, custom audiences)
- No performance metrics (clicks, CTR, conversions)
- No direct media files (only `ad_snapshot_url` — rendered HTML iframe)
- No historical data for removed commercial ads (7-year retention now)

### Access requirements
| Level | What you get |
|---|---|
| No app review | Political/social issue ads only |
| Standard Access (app review + business verification) | ALL ads including commercial |

### Rate limits
- ~200 calls/hour per token
- Up to 500 ads per page (`limit` param)
- ~100K ads/hour max throughput

### Key endpoint
```
GET https://graph.facebook.com/v21.0/ads_archive
  ?access_token=TOKEN
  &ad_reached_countries=['US']
  &search_terms='nike'
  &ad_type=ALL
  &fields=id,ad_creation_time,ad_creative_bodies,ad_creative_link_titles,ad_snapshot_url,page_name,publisher_platforms,estimated_audience_size,ad_delivery_start_time
  &limit=50
```

### Node.js SDK
`facebook-nodejs-business-sdk` (official Meta SDK, npm, v24.0.1)

---

## Competitor Landscape

| Tool | Platforms | Price/mo | Best For | Weakness |
|------|-----------|----------|----------|----------|
| **AdSpy** | FB, IG | $149 | Largest FB database (150M+), comment search | Expensive, dated UI, no TikTok/Google |
| **BigSpy** | 9+ platforms | $0-399 | Multi-platform on a budget | Data quality issues, cluttered UI |
| **Minea** | FB, TikTok, Pinterest | $49-399 | Influencer spy (unique), dropshipping | Smaller FB database |
| **PowerAdSpy** | 7+ platforms | $49-249 | Reddit/Quora coverage (unique) | Buggy search, data freshness issues |
| **Dropispy** | FB, IG | $0-250 | Cheapest option for beginners | Small database, FB/IG only |
| **PiPiADS** | TikTok | $77-263 | Best TikTok ad database | TikTok only |
| **SocialPeta** | 70+ networks | $500-2000+ | Enterprise, mobile gaming | Very expensive, sales-led |
| **FB Ad Library** | FB, IG | Free | Official, complete active ads | No engagement data, limited filters |

### How they source data
1. Facebook Ad Library API (everyone uses this)
2. Browser extensions (passive ad collection from users — AdSpy's secret sauce)
3. Web scraping (landing pages, Shopify stores, TikTok Creative Center)
4. SDK panels (SocialPeta embeds in apps)
5. Purchased panel data

---

## What Users Actually Want (from Reddit, reviews, Product Hunt)

### Top complaints across ALL tools
1. Data freshness — "ads that stopped running months ago"
2. Price — "$150/mo for 80% garbage"
3. No all-in-one — forced to subscribe to 2-3 tools ($200-400/mo)
4. Landing page capture broken — "half are 404"
5. No real engagement data — "likes are useless, I want spend data"
6. Can't filter by success signals — "show me only ads running 30+ days"
7. No creative analysis — "tell me WHY it works"
8. Weak alerts — "notify me when a competitor launches a new ad"
9. UI stuck in 2019
10. No AI/automation

### Features nobody does well yet
- **Ad spend estimation** for commercial ads
- **Real-time alerts** on competitor new ads
- **AI creative analysis** ("this ad works because...")
- **Cross-platform unified view** (same advertiser across FB + TikTok + Google)
- **Funnel spy** (ad -> landing page -> checkout — the full path)
- **Hook/script breakdown** for video ads
- **A/B test detection**
- **Seasonal trend prediction**

---

## Useful GitHub Repos

### Directly relevant
| Repo | Stars | Lang | Use for |
|------|-------|------|---------|
| [facebookresearch/Ad-Library-API-Script-Repository](https://github.com/facebookresearch/Ad-Library-API-Script-Repository) | 303 | Python | Canonical API usage patterns, pagination, CSV output |
| [facebook/facebook-nodejs-business-sdk](https://github.com/facebook/facebook-nodejs-business-sdk) | 586 | JS | Official Node.js SDK for Meta Marketing API |
| [Paularossi/AdDownloader](https://github.com/Paularossi/AdDownloader) | 28 | Python | Media download pipeline from ad snapshots |
| [UWCSESecurityLab/adscraper](https://github.com/UWCSESecurityLab/adscraper) | 43 | TS | Puppeteer ad scraping + landing page capture (most relevant Node.js pattern) |

### For funnel/landing page analysis
| Repo | Stars | Lang | Use for |
|------|-------|------|---------|
| [Lissy93/web-check](https://github.com/Lissy93/web-check) | 32.6K | JS | Website analysis tool architecture reference |
| [unclecode/crawl4ai](https://github.com/unclecode/crawl4ai) | 63.4K | Python | Content extraction, anti-bot, structured data |
| [sindresorhus/pageres](https://github.com/sindresorhus/pageres) | 9.7K | JS | Production screenshot automation (Puppeteer) |

### Ad-specific scrapers
| Repo | Stars | Lang | Notes |
|------|-------|------|-------|
| [minimaxir/facebook-ad-library-scraper](https://github.com/minimaxir/facebook-ad-library-scraper) | 132 | Python | Clean data normalization, demographic handling |
| [ChrisFeldmeier/fb_ad_scraper](https://github.com/ChrisFeldmeier/fb_ad_scraper) | 14 | Python | Rate-limit handling, EU targeting data |
| [Wesleyan-Media-Project/fb_ad_scraper](https://github.com/Wesleyan-Media-Project/fb_ad_scraper) | 3 | Python+R | Scalable queue architecture, parallel scraping |

---

## Our Competitive Angle

### What we can do that others don't
1. **AI-powered trend detection** — not just "here are ads", but "these categories are heating up, these hooks are working"
2. **Funnel analysis** — Puppeteer is already in our stack, capture the full ad -> LP -> checkout flow
3. **Multi-model analysis** — reuse AI Arena's synthesis approach (Claude + GPT-4o + Gemini) for creative analysis
4. **Modern UI** — most tools look like 2019 WordPress plugins
5. **Reasonable pricing** — $49-79/mo vs $149+ for AdSpy

### What we can't compete on (yet)
- Database size (AdSpy has 150M+ ads from years of browser extension data)
- Browser extension panel data (engagement metrics beyond what API provides)
- Multi-platform (start with Facebook, add TikTok later)

### MVP scope
1. Facebook Ad Library API integration (search by keyword, category, country)
2. "Running longest" = profitable signal (sort by ad duration)
3. Trending detection (new ads scaling fast)
4. Basic filters: country, platform, active duration, page
5. Ad snapshot rendering + screenshot
6. Simple dashboard

### Phase 2 (the moat)
- Funnel capture: Puppeteer clicks through ad -> LP -> captures full flow
- AI analysis: "This ad uses urgency + social proof, LP has X structure, estimated conversion pattern"
- Alerts: "New ad from [competitor] detected"
- Trend reports: "Top 10 trending hooks in [category] this week"

---

## Before starting tomorrow

### Action items
1. **Create a Meta Developer App** and apply for Standard Access (`ads_read`)
2. **Business verification** in Meta Business Manager (required for commercial ads)
3. **Generate access token** via Graph API Explorer to test queries
4. **Pick a niche** to start with (e-commerce? SaaS? local business?) — easier to build category-specific than generic

### Stack decision
Same as AI Arena: Node/Express + vanilla JS frontend + Railway. Already proven, already have the infra.
