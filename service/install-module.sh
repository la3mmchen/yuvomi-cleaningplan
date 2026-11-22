#!/bin/sh
# Copies the module page baked into this image (/module) into Yuvomi's modules folder, so
# page and sidecar are always the same version. Meant as an init container next to the
# sidecar, with Yuvomi's modules folder mounted at $MODULES_DIR (default /modules).
#
# A folder placed this way has no install record, so Yuvomi treats it as copied by hand:
# served enabled without the approval step, and no longer replaceable from Settings
# (MODULES.md, "Disabled until approved"). Yuvomi rescans changed folders at runtime.
set -eu
dir="${MODULES_DIR:-/modules}"
owner="${MODULE_OWNER:-1000:1000}"   # Yuvomi's user in its image
id=cleaningplan
new="$dir/.$id-new"
old="$dir/.$id-old"

rm -rf "$new" "$old"
cp -R /module "$new"
chown -R "$owner" "$new"
# Two renames instead of copying over the live folder: Yuvomi never scans a half-written one.
if [ -e "$dir/$id" ]; then mv "$dir/$id" "$old"; fi
mv "$new" "$dir/$id"
rm -rf "$old"
echo "installed module $id $(node -p "require('$dir/$id/module.json').version")"
