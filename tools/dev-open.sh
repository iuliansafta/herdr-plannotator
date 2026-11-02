#!/bin/sh
# Open a mod on a session URL in a new tab of the test screen and screenshot it.
# Usage: dev-open.sh <mod-name> <url> <out.png> [extra-props-json]
# Prints the tab id; close it with: HERDR_APP_HOME=/run/user/$(id -u)/hpt herdr-app do tab.close --id <tab> --confirmed true
set -eu
export HERDR_APP_HOME=/run/user/$(id -u)/${HPT:-hpt}
mod=$1 url=$2 out=$3 extra=${4:-'{}'}
space=$(herdr-app ls | jq -r '.spaces[] | select(.machine == null) | .id' | head -1)
props=$(jq -cn --arg url "$url" --argjson extra "$extra" '{url: $url} + $extra')
tab=$(herdr-app do tab.new --space "$space" --name "dev-$mod" --mod "$mod" --props "$props" | jq -r .tab)
herdr-app do space.select --id "$space" >/dev/null
herdr-app do tab.select --id "$tab" >/dev/null
sleep "${DEV_WAIT:-2.5}"
herdr-app shot "$out" >/dev/null
echo "$tab"
