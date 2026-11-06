#!/bin/sh
set -eu

version=$(cat .node-version)
if [ "$version" != '24.22.2' ]; then
	echo 'Update the sandbox runtime checksums for the pinned Node version.' >&2
	exit 1
fi

case $(uname -m) in
aarch64 | arm64)
	architecture=arm64
	checksum=95c264150aceb7f3437a29fd6984924f5f8d1511ea3cbd6c508b83f6c555dae2
	;;
x86_64)
	architecture=x64
	checksum=361718c444e49af2ca5a110c83ba6a8901143f23ab285ebbef0341f391f482a9
	;;
*)
	echo 'The sandbox requires Linux arm64 or x64.' >&2
	exit 1
	;;
esac

destination="$HOME/.local/typepeek-node"
if [ -x "$destination/bin/node" ] && [ "$("$destination/bin/node" --version)" = "v$version" ]; then
	exit 0
fi

temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT HUP INT TERM
archive="node-v$version-linux-$architecture.tar.gz"
curl --fail --location --silent --show-error "https://nodejs.org/dist/v$version/$archive" --output "$temporary/$archive"
printf '%s  %s\n' "$checksum" "$archive" >"$temporary/checksum"
(cd "$temporary" && sha256sum --check checksum)
mkdir -p "$destination"
tar -xzf "$temporary/$archive" --strip-components=1 -C "$destination"
