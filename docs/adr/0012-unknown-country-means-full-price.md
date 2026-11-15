# A buyer whose country is unknown pays full price

Purchasing-power prices depend on the buyer's country. `resolveCountry` takes it from the dev session override or Cloudflare's `CF-IPCountry` header, and nothing else. When neither gives a country, the buyer pays full price. We accept overcharging some of the learners purchasing-power pricing is for, so that no page ever waits on a network call to learn the country.

## Considered Options

- **Look up the first `X-Forwarded-For` address on ip-api.com.** We did this, and backed out: the course list, the purchase page and every lesson page for a discounted purchase could wait on a network call, the free endpoint is plain HTTP, and it is limited to 45 requests a minute.
- **Bundle a MaxMind GeoLite2 database.** Rejected: it needs a licence key, a download of tens of megabytes, and an update every month.
