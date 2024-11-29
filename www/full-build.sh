#!/usr/bin/env bash

set -ex

cd "$(dirname "${BASH_SOURCE[0]}")"
dvc pull public/njdot/data/{cmymc,crashes,drivers,occupants,pedestrians,vehicles}.db
aws s3 sync --exclude '*' --include 'crashes.db' s3://nj-crashes/njsp/data/ public/njsp/data/
npm run build
