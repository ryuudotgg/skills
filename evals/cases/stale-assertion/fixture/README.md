# app

## slugify(input)

Lowercases the input, turns every run of characters outside a to z and 0 to 9 into one hyphen, and trims hyphens from both ends. Digits are kept: `Top 10 Tips!` becomes `top-10-tips`, so numbered posts get distinct permalinks.

## permalink(post)

Returns `/<year>/<slug>`, with the slug from `slugify(post.title)`.
