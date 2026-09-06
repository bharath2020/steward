#!/bin/bash
exec /bin/bash "$(dirname "$0")/../Setup Steward.command" --example questions --new-run "$@"
