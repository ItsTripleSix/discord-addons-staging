# Repository names and compatibility

Repository names describe release roles, independent of Discord client or device platform. Individual add-ons still have client-specific compatibility requirements.

| Repository | Visibility | Purpose |
| --- | --- | --- |
| [discord-addons](https://github.com/ItsTripleSix/discord-addons) | Public | Stable releases for supported Discord clients |
| [discord-addons-staging](https://github.com/ItsTripleSix/discord-addons-staging) | Public | Testing, release candidates, and publicly fetchable builds |
| discord-addons-workbench | Private | Development source, experiments, tests, and migration work |
| [ShiggyCord](https://github.com/ItsTripleSix/ShiggyCord) | Public | The ShiggyCord client fork |

## Historical aliases

The repositories were renamed in place on 2026-09-15. These are historical names, not canonical URLs for new documentation or source:

| Historical name | Current name |
| --- | --- |
| revenge-plugins | discord-addons |
| revenge-plugins-temp | discord-addons-staging |
| revenge-development | discord-addons-workbench |

All three retain their repository identity, existing branches, history, visibility, and main default branch. The ShiggyCord fork is unchanged. Do not recreate repositories at the historical names while installed clients depend on their redirects.

## Compatibility paths and client layout

Existing plugins/ and themes/ paths are retained. In the workbench, shiggy/plugins/ is also retained. No existing install path or release bundle is removed.

The client directories mirror the retained paths listed in client-layout.json. For now, make source edits at those retained paths, then run:

~~~sh
node scripts/sync-client-layout.cjs --write
node scripts/sync-client-layout.cjs --check
~~~

Commit the source and mirrors together. The script copies within this repository only and never deletes files, pushes commits, or promotes builds between repositories.

New clients can be added under clients/<client>/plugins/ and clients/<client>/themes/. Only assets with established cross-client compatibility belong under shared/. A folder reserved for a client does not imply that a build is released for it.

Changing an installed plugin's URL can change its local plugin identity and storage. Existing installations should keep their current entry during this transition; do not install a second copy just to adopt the new path. Retire compatibility paths only after active consumers have been identified and deliberately migrated.

## Purge Tools delivery

The active public ShiggyCord refetch root remains the existing plugin path in the renamed staging repository:

~~~text
https://raw.githubusercontent.com/ItsTripleSix/discord-addons-staging/main/plugins/purge-tools/
~~~

The parallel client-specific root is:

~~~text
https://raw.githubusercontent.com/ItsTripleSix/discord-addons-staging/main/clients/shiggycord/plugins/purge-tools/
~~~

Both serve the same index.js and manifest.json. The Shiggy wrapper fetches its core from:

~~~text
https://raw.githubusercontent.com/ItsTripleSix/discord-addons/main/plugins/purge-tools/index.js
~~~

The wrapper's media filtering and account-scoped checkpoint behavior are unchanged by the URL migration. Its manifest hash must equal the Git blob SHA of the wrapper index.js. Check the public raw responses and hashes before requesting a refetch. A private workbench update alone does not update staging.

## Reference changes

Current source and documentation use the new repository names. The changed stable install URLs cover Account Switcher, Silent Typing, Composer Cleaner, Purge Tools, Hidden Channels, Quick Mock, Theme Toolkit, and the AMOLED Monochrome theme. The Purge Tools wrapper's core URL changes in both staging and workbench. Workbench Theme Toolkit documentation and its builder test fixture also use the new stable URL.

Existing historical commits, snapshot branches, and other non-default branches retain their recorded contents. Reconcile the current main branch before resuming work from them. Historical release bundles remain byte-identical. The Shiggy startup-test workflow uses its current checkout for publishing and the upstream ShiggyCord URL for cloning; neither contains an old add-on repository URL.

## Pre-existing stable packaging issues

The rename audit found these existing stable manifests referencing files absent from the stable repository. They are preserved, including in the client mirror, rather than replacing a stable release with a different build.

| Plugin | Missing manifest entry point |
| --- | --- |
| Composer Cleaner | plugins/composer-cleaner/plugin.js |
| Hidden Channels | plugins/hidden-channels/index-v3.js |
| Quick Mock | plugins/quick-mock/index-v7.js |

Their existing index.js files and manifests are retained. These three packages need a separate release repair before their manifest-based installation can be considered verified. The repository rename does not establish their runtime compatibility.
