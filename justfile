set shell := ["bash", "-euo", "pipefail", "-c"]

default:
    @just --list

# Build the ACP binary and the bundled pi extension into dist/
build:
    npm run build

# Typecheck, lint and test
check:
    npm run typecheck
    npm run lint
    npm test

# Verify committed dist/ matches a fresh build (used by CI)
dist-check:
    #!/usr/bin/env bash
    set -euo pipefail
    npm run build
    if [ -n "$(git status --porcelain -- dist)" ]; then
        printf 'dist/ is stale — run `just release`\n' >&2
        git status --porcelain -- dist >&2
        exit 1
    fi

# Build, bump package.json version, commit dist/, and tag vX.Y.Z
# usage: just release [patch|minor|major|<version>]
release bump="patch":
    #!/usr/bin/env bash
    set -euo pipefail

    if ! git symbolic-ref --quiet --short HEAD >/dev/null; then
        printf 'refusing to release from a detached HEAD\n' >&2
        exit 1
    fi

    dirty=$(git status --porcelain -- . ':(exclude)dist' ':(exclude)package-lock.json')
    if [ -n "$dirty" ]; then
        printf 'working tree is dirty (dist/ and package-lock.json excluded):\n%s\n' "$dirty" >&2
        exit 1
    fi

    just check

    npm version {{bump}} --no-git-tag-version >/dev/null
    version=$(node -p "require('./package.json').version")
    tag="v$version"

    if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
        git checkout -- package.json package-lock.json
        printf 'tag %s already exists\n' "$tag" >&2
        exit 1
    fi

    npm run build

    git add package.json package-lock.json dist
    if git diff --cached --quiet; then
        printf 'nothing to commit\n' >&2
    else
        git commit -m "chore(release): $tag"
    fi
    git tag -a "$tag" -m "$tag"

    printf '\ntagged %s\n' "$tag"
    printf 'publish with: git push --follow-tags\n'
