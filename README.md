# discord-addons-staging

Public staging/refetch compatibility repository.

The tested ShiggyCord collection has been promoted to the stable [`discord-addons`](https://github.com/ItsTripleSix/discord-addons) repository and released there.

## Stable release

Use the stable repository for new ShiggyCord installs:

`https://github.com/ItsTripleSix/discord-addons/tree/main/clients/shiggycord/plugins`

Release page:

`https://github.com/ItsTripleSix/discord-addons/releases/tag/shiggycord-plugins-2026.09.16`

## Compatibility paths retained

The existing `plugins/` and `clients/shiggycord/plugins/` copies are intentionally retained so already-installed staging/refetch URLs continue to work. They currently mirror the released builds.

The old test bundle, smoke-test scripts/workflows, migration scaffolding, unused client placeholders, and other retired staging artifacts were removed after promotion.

## Current retained plugins

- Account Switcher
- Composer Cleaner
- Hidden Channels
- Purge Tools
- Quick Mock
- Settings Pins
- Silent Typing

Theme Toolkit remains separate and is not part of the ShiggyCord release.

## License

MIT
