# Local incident server

From the repository root, run `npm run seed`, then `npm run start`.
The server prints its actual URL, normally `http://127.0.0.1:3000`.
Set `PORT` to another port, or `PORT=0` for an available ephemeral port.
Press Ctrl+C to close it gracefully. Run `npm test` for verification.

The server reads `.runtime/incidents.json` without changing it and serves
the repository's `public/` directory when frontend files are present.
Only GET requests are supported. API errors are `{error:{code,message}}`.

`/api/incidents` accepts literal case-insensitive `q` over ID, title and
description; repeated `service`, `status` and `severity`; inclusive UTC
`from` and `to` dates in YYYY-MM-DD form; `sort=openedAt|severity`;
`direction=asc|desc`; a positive `page`; and `pageSize=25|50`.
Defaults are no filters, openedAt descending, page 1 and size 25.
Facet values are case-sensitive and use the dataset's exact enumerations.
Values within a facet are OR, and separate facets are AND.
Opened-date ties use ID ascending. Severity ties use openedAt descending,
then ID ascending. Page requests clamp to the available range.
Summaries cover all matches, with chronological UTC day buckets.

`/api/overview` accepts and validates the same parameters as `/api/incidents`.
Its measures always cover the entire filtered result, independent of page,
page size and sorting. It returns `{total,services}`; each matching service has
`service`, `incidentCount`, `unresolvedCount`, `highSeverityCount` and
`averageResolutionHours`. Unresolved means open or in progress. High severity
means critical or high, including resolved incidents. The average is elapsed
hours from opening to resolution for resolved incidents only; open and in-progress
incidents are excluded. With no resolved incidents the average is `null`, not zero.
Services are ordered by unresolved count descending, then service name ascending.
An empty result is `{total:0,services:[]}`. Like incident responses, overview
responses disable caching and use the same structured error format.

`/api/incidents/:id` returns every incident field, or 404.
`/api/export.csv` applies the same filters and sorting, ignores pagination,
and exports all fields in dataset order. Tags are JSON array text, null is
empty, quotes are doubled, and records use CRLF.
