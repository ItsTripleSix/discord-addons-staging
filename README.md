# discord-addons-staging

Public staging, testing, release candidates, and refetch builds for Discord add-ons across supported mobile and desktop clients.

## Repository roles

| Repository | Visibility | Purpose |
| --- | --- | --- |
| [discord-addons](https://github.com/ItsTripleSix/discord-addons) | Public | Stable releases for supported Discord clients |
| [discord-addons-staging](https://github.com/ItsTripleSix/discord-addons-staging) | Public | Testing, release candidates, and publicly fetchable builds |
| discord-addons-workbench | Private | Development source, experiments, tests, and migration work |
| [ShiggyCord](https://github.com/ItsTripleSix/ShiggyCord) | Public | The ShiggyCord client fork |

## Layout and current installs

Client-specific copies live under clients/. Existing plugin and theme paths remain available for installed clients. [Migration and compatibility notes](docs/repository-migration.md) explain the paths, maintenance command, and known pre-existing packaging issues.

These repositories can hold add-ons for supported mobile or desktop Discord clients; check each add-on's actual client requirements. No ShiggyCord build is promoted to stable by this reorganization.

## Current ShiggyCord testing collection

The retained plugins/ collection is used for ShiggyCord testing. Copies are available under clients/shiggycord/plugins/. Individual plugins may still depend on the Vendetta-compatible API; placement in staging does not claim complete device validation.

| Plugin | Retained path |
| --- | --- |
| Account Switcher | plugins/account-switcher/ |
| Composer Cleaner | plugins/composer-cleaner/ |
| Hidden Channels | plugins/hidden-channels/ |
| Purge Tools | plugins/purge-tools/ |
| Quick Mock | plugins/quick-mock/ |
| Settings Pins | plugins/settings-pins/ |
| Silent Typing | plugins/silent-typing/ |

Purge Tools' established refetch entry remains:

~~~text
https://raw.githubusercontent.com/ItsTripleSix/discord-addons-staging/main/plugins/purge-tools/
~~~

The client-specific copy is:

~~~text
https://raw.githubusercontent.com/ItsTripleSix/discord-addons-staging/main/clients/shiggycord/plugins/purge-tools/
~~~

Keep an existing installed entry while its saved settings and checkpoints are in use. The source URL change does not require installing a duplicate plugin.

## Client test bundle

shiggy-test/shiggycord.js and its build workflow are retained. They are client-test artifacts, separate from the add-on collection.

## License

MIT
