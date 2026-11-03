#!/bin/sh
# Started as root (plain docker/compose): make /data writable for the node user whatever
# kind of mount it is, then drop privileges. Started as another user (rootless, TrueNAS):
# run as that user.
set -e
if [ "$(id -u)" = "0" ]; then
  chown -R node:node /data
  HOME=$(getent passwd node | cut -d: -f6)
  export HOME
  exec setpriv --reuid=node --regid=node --init-groups -- "$@"
fi
exec "$@"
