# Community rule packs

A rule pack adds rules to Searvex without code. Load it with `--rules-pack <name>` (a folder here) or
`--rules-pack <path>` (any folder); repeat the flag for several packs. See CONTRIBUTING.md for how to propose one.

- The folder name is the pack name (`a-z`, `0-9`, `-`) and prefixes every rule id: `shop.product-schema-missing`.
  A pack can never replace a core rule or another pack's rule.
- Files are `*.json` in the core rule-file format (`version`, `updated`, `rules`), and each rule meets the core
  requirements: official sources on the allowlist with a `checked` date, `description`, `fix` and `verify`.
- Each rule has a declarative `check` that runs on every indexable HTML page:

| Key | Values |
|---|---|
| `field` | `title`, `description`, `h1`, `lang`, `canonical`, `jsonld-types`, `og:<property>`, `twitter:<name>`, `header:<name>` |
| `test` | `missing`, `present`, `matches`, `not-matches`, `longer-than`, `shorter-than` |
| `value` | a regular expression (case-insensitive, ≤ 200 characters, no quantified group with an inner quantifier, no back-references) for `matches` / `not-matches`; an integer for the length tests |
| | `not-matches` also fires when the field is missing ("no Product type" includes pages without JSON-LD); the length tests apply only when the field is present |
| `urlPattern` | optional regular expression on the URL path; other pages are skipped |

Validate a pack with `searvex rules validate --rules-pack <name|path>`. Pack findings are labelled with the pack
name in every report format and in `report.json` (`findings[].pack`, `tool.packs`).
