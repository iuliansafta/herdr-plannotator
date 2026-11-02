---
title: Rate limiter rollout
owner: platform-team
status: draft
---

# Implementation Plan: Token-bucket rate limiter

## Context

The public API currently has **no per-tenant limits**, so a single noisy client can starve
everyone else. This plan adds a *token-bucket* limiter in front of the `/v2` routes, backed by
Redis, and rolls it out behind the `rate_limit_v2` flag. See [the RFC](https://example.com/rfc/42).

> [!NOTE]
> Existing global limits in nginx stay in place until phase 3.

## Goals

1. Cap each tenant at a configurable rate (default **100 req/s**, burst 200).
2. Return `429 Too Many Requests` with a `Retry-After` header.
3. Keep p99 latency overhead under ~~5 ms~~ **2 ms**.

## Steps

- [x] Add the `RateLimiter` interface in `internal/limits`
- [ ] Implement the Redis backend
  - Lua script for atomic take-and-refill
  - Fallback to *allow* when Redis is unreachable
- [ ] Wire the middleware into the router
- [ ] Add dashboards and alerts

### Middleware

```go
func RateLimit(l Limiter) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !l.Allow(r.Context(), tenantID(r)) {
				w.Header().Set("Retry-After", "1")
				http.Error(w, "rate limited", http.StatusTooManyRequests)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
```

### Configuration

| Setting | Default | Notes |
|---------|---------|-------|
| `rate` | 100 | requests per second |
| `burst` | 200 | bucket size |
| `fail_open` | true | allow traffic when Redis is down |

---

## Risks

Redis becomes a hard dependency on the hot path. If the cluster is slow, every request pays
for it, so the client uses a **5 ms timeout** and fails open.

#### Rollback

Flip `rate_limit_v2` off. No migration is needed.
