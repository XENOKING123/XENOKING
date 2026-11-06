# Permission requests — the route to hundreds of GB

The archive downloads a source in bulk as soon as you record its permission
(dashboard → Sources → **Permission…** → `MIRROR_ALLOWED` + evidence). Keep the reply
(email / DM screenshot / forum post link) and paste its link or a short description as the evidence.

## Template — site operators (The Tech Game, PlayerSquared, GBAtemp, SaveGameWorld, …)

> **Subject:** Permission to archive and redistribute community PS4/PS5 saves (with credit)
>
> Hi <site> team,
>
> I run XenoSaves, a free PS4/PS5 save library. I'd like to archive the publicly shared saves in your
> <section name> section and offer them for download on XenoSaves, with:
>
> - full credit to the original creator/uploader and a link back to the original post on <site>;
> - the original description, title ID and region kept exactly as posted;
> - a takedown process: any uploader or your staff can have a file removed at any time;
> - polite, rate-limited collection (or, if you prefer, a data export / official token you provide).
>
> Would you allow this? If yes, please confirm (a) that redistribution is allowed, (b) whether downloads may be
> collected automatically and at what rate, and (c) any attribution wording you require.
>
> Thanks, <name> — <contact>

## Template — GitHub repo owners without a licence

Open an issue on the repo:

> Hi! Would you consider adding a licence (e.g. CC0, CC-BY-4.0 or GPL-3.0) to these saves so they can be
> mirrored with credit in the XenoSaves archive? Without a licence others can't legally redistribute them.
> Thanks for sharing them!

When a licence is added, the next discovery run detects it automatically and queues the files.

## Recording owner-provided scraper exports

1. Put the export in `imports/<site>.json` (or `.jsonl` / `.csv`; columns: see `docs/examples/link-list.example.json`).
2. Dashboard → the `<site>-import` source → **Permission…** → `MIRROR_ALLOWED`, evidence = the permission reply.
3. **Enable** the source → **Discover now**. The worker downloads everything; anything behind a login, captcha,
   password or quota is recorded as `RESTRICTED` (never bypassed). If the site issued an archive token, set
   `config.auth` on the source (header name, env var, allowed hosts) and the secret in the server `.env`.
