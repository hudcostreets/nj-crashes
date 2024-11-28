#!/usr/bin/env bash

set -ex

cd "$(dirname "${BASH_SOURCE[0]}")"
node download-dbs.js
npm run build
