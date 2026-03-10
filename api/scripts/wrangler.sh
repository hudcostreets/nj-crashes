#!/usr/bin/env bash
# Wrapper to run wrangler with CLOUDFLARE_API_TOKEN from env
exec npx wrangler "$@"
