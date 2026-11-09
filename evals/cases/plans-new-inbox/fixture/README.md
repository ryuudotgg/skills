# slugs

One export, `slugify(title)` in `src/slugify.js`, used by the Feeds project to build episode URLs.

A slug is the title's ASCII letters and digits, lowercased, with every other run of characters replaced by one dash and no dash at either end. Other letters, accented ones included, are dropped. `slugify("Episode 12: Café!")` is `episode-12-caf`.
