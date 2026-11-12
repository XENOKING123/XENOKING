import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeftRight,
  ArrowRight,
  Check,
  FolderOpen,
  Loader2,
  Minus,
  Search,
  X,
} from "lucide-react";

import {
  saveConverterConvert,
  saveConverterGames,
  saveConverterInspect,
  saveConverterReveal,
  type ConvertReport,
  type Direction,
  type GameProfile,
  type GameStatus,
  type InspectReport,
} from "../../api/saveConverter";
import {
  PageHeader,
  Button,
  EmptyState,
  ErrorCard,
  SuccessCard,
  WarningCard,
} from "../../components";
import { useGameCover } from "../../lib/covers";
import { formatBytes } from "../../lib/format";
import { pickPath } from "../../lib/pickPath";
import {
  filterGames,
  optionPayload,
  optionProblem,
  optionsFor,
  optionsReady,
  sourcePlatform,
  targetPlatform,
} from "../../lib/saveConverter";
import { useConnectionStore } from "../../state/connection";
import { useTr } from "../../state/lang";
import { pushNotification } from "../../state/notifications";

type Tr = ReturnType<typeof useTr>;

/**
 * XENO Save Converter — PS5 ⇄ PC.
 *
 * Pick a game from the database, pick a direction, point at the save
 * folder; the backend rewrites it for the other platform into a brand-new
 * folder. Purely local-disk work: no console connection is needed, so
 * there's no ConnectionGate here.
 *
 * The screen is a straight-line form (source → options → destination →
 * convert). The folder is dry-run inspected as soon as it's picked, so
 * the user sees exactly which files will be converted — and why not, if
 * not — before anything is written.
 */
export default function SaveConverterScreen() {
  const tr = useTr();
  const [games, setGames] = useState<GameProfile[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [term, setTerm] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [direction, setDirection] = useState<Direction>("ps5_to_pc");

  const [inputDir, setInputDir] = useState("");
  const [inspect, setInspect] = useState<InspectReport | null>(null);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [inspecting, setInspecting] = useState(false);

  const [optionValues, setOptionValues] = useState<Record<string, string>>({});
  const [outputDir, setOutputDir] = useState("");

  const [converting, setConverting] = useState(false);
  const [result, setResult] = useState<ConvertReport | null>(null);
  const [convertError, setConvertError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    saveConverterGames()
      .then((list) => {
        if (cancelled) return;
        setGames(list);
        setSelectedId((current) => current ?? list[0]?.id ?? null);
      })
      .catch((e) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const shown = useMemo(() => filterGames(games ?? [], term), [games, term]);
  const game = games?.find((g) => g.id === selectedId) ?? null;

  // A source folder belongs to one game on one platform, so switching
  // either invalidates it (and whatever was converted from it). The
  // destination folder and typed options are worth keeping.
  function resetSource() {
    setInputDir("");
    setInspect(null);
    setInspectError(null);
    setResult(null);
    setConvertError(null);
  }

  function selectGame(id: string) {
    if (id === selectedId) return;
    setSelectedId(id);
    resetSource();
  }

  function selectDirection(next: Direction) {
    if (next === direction) return;
    setDirection(next);
    resetSource();
  }

  // Dry-run the picked folder. `runId` drops a slow answer for a folder,
  // game or direction the user has since moved on from.
  const runId = useRef(0);
  const gameId = game?.id ?? null;
  useEffect(() => {
    const id = ++runId.current;
    setInspect(null);
    setInspectError(null);
    if (!gameId || !inputDir) {
      setInspecting(false);
      return;
    }
    setInspecting(true);
    saveConverterInspect(gameId, direction, inputDir)
      .then((report) => {
        if (runId.current === id) setInspect(report);
      })
      .catch((e) => {
        if (runId.current === id) {
          setInspectError(e instanceof Error ? e.message : String(e));
        }
      })
      .finally(() => {
        if (runId.current === id) setInspecting(false);
      });
  }, [gameId, direction, inputDir]);

  async function chooseInput() {
    const picked = await pickPath({
      mode: "folder",
      title:
        direction === "ps5_to_pc"
          ? tr("save_converter_pick_ps5", "Choose the decrypted PS5 save folder")
          : tr("save_converter_pick_pc", "Choose the PC save folder"),
    });
    if (!picked) return;
    setResult(null);
    setConvertError(null);
    setInputDir(picked);
  }

  async function chooseOutput() {
    const picked = await pickPath({
      mode: "folder",
      title: tr(
        "save_converter_pick_output",
        "Choose where to put the converted save",
      ),
    });
    if (picked) setOutputDir(picked);
  }

  async function handleConvert() {
    if (!game || !inspect?.convertible || converting) return;
    setConverting(true);
    setResult(null);
    setConvertError(null);
    try {
      const report = await saveConverterConvert(
        game.id,
        direction,
        inputDir,
        outputDir,
        optionPayload(game, direction, optionValues),
      );
      setResult(report);
      pushNotification(
        "success",
        `${game.name}: ${tr("save_converter_done_toast", "save converted for")} ${targetPlatform(direction)}`,
        { body: report.output_dir },
      );
    } catch (e) {
      setConvertError(e instanceof Error ? e.message : String(e));
    } finally {
      setConverting(false);
    }
  }

  const options = game ? optionsFor(game, direction) : [];
  const source = sourcePlatform(direction);
  const target = targetPlatform(direction);

  // The first unmet requirement, shown next to the disabled button so the
  // user is never left guessing why Convert is greyed out.
  let waitingOn: string | null = null;
  if (game) {
    if (!inputDir) {
      waitingOn = tr("save_converter_need_source", "Choose the save folder first.");
    } else if (inspecting) {
      waitingOn = tr("save_converter_checking", "Checking the folder…");
    } else if (!inspect?.convertible) {
      waitingOn = tr(
        "save_converter_need_fix",
        "This folder can't be converted — see above.",
      );
    } else if (!optionsReady(game, direction, optionValues)) {
      const first = options.find(
        (o) => optionProblem(o, optionValues[o.key] ?? "") !== null,
      );
      waitingOn = `${tr("save_converter_need_option", "Fill in")} ${first?.label ?? ""}.`;
    } else if (!outputDir) {
      waitingOn = tr(
        "save_converter_need_output",
        "Choose where to put the converted save.",
      );
    }
  }

  return (
    <div className="p-6">
      <PageHeader
        icon={ArrowLeftRight}
        title={tr("save_converter", "Save Converter")}
        count={
          games
            ? `${games.length} ${games.length === 1 ? tr("save_converter_game", "game") : tr("save_converter_games", "games")}`
            : undefined
        }
        loading={games === null && !loadError}
        description={tr(
          "save_converter_description",
          "Move a game save between PS5 and PC — in either direction. Pick the game, pick the direction, point at the save. Your original files are never changed.",
        )}
      />

      {loadError && (
        <ErrorCard
          title={tr(
            "save_converter_load_error",
            "Couldn't load the game database",
          )}
          detail={loadError}
        />
      )}

      {games && games.length === 0 && (
        <EmptyState
          icon={ArrowLeftRight}
          message={tr(
            "save_converter_empty",
            "No games in the converter database yet.",
          )}
        />
      )}

      {games && games.length > 0 && (
        <div className="grid items-start gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
          {/* ── game list ─────────────────────────────────────────── */}
          <aside className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3">
            <div className="relative mb-2">
              <Search
                size={15}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-muted)]"
              />
              <input
                value={term}
                onChange={(e) => setTerm(e.target.value)}
                placeholder={tr("save_converter_search", "Search games…")}
                aria-label={tr("save_converter_search", "Search games…")}
                className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] py-2 pl-9 pr-3 text-sm outline-none focus:border-[var(--color-gold)]"
              />
            </div>
            <ul className="max-h-[60vh] space-y-1 overflow-y-auto">
              {shown.map((g) => (
                <li key={g.id}>
                  <GameRow
                    game={g}
                    active={g.id === selectedId}
                    onSelect={() => selectGame(g.id)}
                    tr={tr}
                  />
                </li>
              ))}
            </ul>
            {shown.length === 0 && (
              <p className="px-1 py-6 text-center text-xs text-[var(--color-muted)]">
                {tr("save_converter_no_match", "No game matches that search.")}
              </p>
            )}
          </aside>

          {/* ── converter ─────────────────────────────────────────── */}
          {game && (
            <div className="min-w-0 space-y-4">
              <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-lg font-semibold">{game.name}</h2>
                  <StatusChip status={game.status} tr={tr} />
                </div>
                <GameMeta game={game} tr={tr} />
                {game.status !== "ready" && (
                  <p className="mt-2 text-xs text-[var(--color-muted)]">
                    {game.status === "wip"
                      ? tr(
                          "save_converter_wip_hint",
                          "This converter is still being built. You can check a save folder against it, but converting stays off until it's been verified with real saves.",
                        )
                      : tr(
                          "save_converter_experimental_hint",
                          "This converter works on our test saves but hasn't been confirmed in-game in both directions yet. Keep a backup of the save you're replacing.",
                        )}
                  </p>
                )}
                {game.notes.length > 0 && (
                  <ul className="mt-2 list-disc space-y-0.5 ps-5 text-xs text-[var(--color-muted)]">
                    {game.notes.map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </ul>
                )}

                <div
                  role="radiogroup"
                  aria-label={tr("save_converter_direction", "Direction")}
                  className="mt-4 grid gap-2 sm:grid-cols-2"
                >
                  <DirectionButton
                    from="PS5"
                    to="PC"
                    active={direction === "ps5_to_pc"}
                    onSelect={() => selectDirection("ps5_to_pc")}
                  />
                  <DirectionButton
                    from="PC"
                    to="PS5"
                    active={direction === "pc_to_ps5"}
                    onSelect={() => selectDirection("pc_to_ps5")}
                  />
                </div>
              </section>

              {/* 1 — source */}
              <Step
                n={1}
                title={
                  direction === "ps5_to_pc"
                    ? tr(
                        "save_converter_source_ps5",
                        "Your decrypted PS5 save folder",
                      )
                    : tr("save_converter_source_pc", "Your PC save folder")
                }
              >
                <SourceHint game={game} direction={direction} tr={tr} />
                <FolderField
                  path={inputDir}
                  onChoose={() => void chooseInput()}
                  disabled={converting}
                  tr={tr}
                />
                {inspecting && (
                  <p className="mt-3 text-xs text-[var(--color-muted)]">
                    <Loader2 size={12} className="me-1.5 inline animate-spin" />
                    {tr("save_converter_checking", "Checking the folder…")}
                  </p>
                )}
                {inspectError && (
                  <div className="mt-3">
                    <ErrorCard
                      title={tr(
                        "save_converter_inspect_error",
                        "Couldn't read that folder",
                      )}
                      detail={inspectError}
                    />
                  </div>
                )}
                {inspect && (
                  <InspectView
                    report={inspect}
                    pickedDir={inputDir}
                    source={source}
                    tr={tr}
                  />
                )}
              </Step>

              {/* 2 — per-game options (only when this direction has any) */}
              {options.length > 0 && (
                <Step
                  n={2}
                  title={tr("save_converter_options", "Details for this game")}
                >
                  <div className="space-y-3">
                    {options.map((spec) => {
                      const value = optionValues[spec.key] ?? "";
                      // Don't nag about an empty field; the hint by the
                      // Convert button covers "still needed".
                      const problem =
                        value.trim() === "" ? null : optionProblem(spec, value);
                      return (
                        <label key={spec.key} className="block">
                          <span className="block text-sm font-medium">
                            {spec.label}
                            {!spec.required && (
                              <span className="ms-1.5 text-xs font-normal text-[var(--color-muted)]">
                                {tr("save_converter_optional", "(optional)")}
                              </span>
                            )}
                          </span>
                          <input
                            value={value}
                            onChange={(e) =>
                              setOptionValues((prev) => ({
                                ...prev,
                                [spec.key]: e.target.value,
                              }))
                            }
                            inputMode={
                              spec.kind === "steam_id64" ? "numeric" : "text"
                            }
                            placeholder={
                              spec.kind === "steam_id64" ? "7656119…" : ""
                            }
                            spellCheck={false}
                            autoComplete="off"
                            disabled={converting}
                            aria-invalid={problem !== null}
                            className={`mt-1 w-full max-w-sm rounded-lg border bg-[var(--color-surface)] px-3 py-2 font-mono text-sm outline-none focus:border-[var(--color-gold)] ${
                              problem
                                ? "border-[var(--color-bad)]"
                                : "border-[var(--color-border)]"
                            }`}
                          />
                          {problem && (
                            <span className="mt-1 block text-xs text-[var(--color-bad)]">
                              {problem}
                            </span>
                          )}
                          {spec.help && (
                            <span className="mt-1 block text-xs text-[var(--color-muted)]">
                              {spec.help}
                            </span>
                          )}
                        </label>
                      );
                    })}
                  </div>
                </Step>
              )}

              {/* 3 — destination */}
              <Step
                n={options.length > 0 ? 3 : 2}
                title={tr(
                  "save_converter_output",
                  "Where to put the converted save",
                )}
              >
                <p className="mb-2 text-xs text-[var(--color-muted)]">
                  {tr(
                    "save_converter_output_hint",
                    "A new folder is created inside the one you pick — nothing that's already there is overwritten.",
                  )}
                </p>
                <FolderField
                  path={outputDir}
                  onChoose={() => void chooseOutput()}
                  disabled={converting}
                  tr={tr}
                />
              </Step>

              <div className="flex flex-wrap items-center gap-3">
                <Button
                  variant="primary"
                  size="md"
                  leftIcon={<ArrowLeftRight size={15} />}
                  loading={converting}
                  disabled={waitingOn !== null}
                  onClick={() => void handleConvert()}
                >
                  {`${tr("save_converter_convert_to", "Convert to")} ${target}`}
                </Button>
                {waitingOn && !converting && (
                  <span className="text-xs text-[var(--color-muted)]">
                    {waitingOn}
                  </span>
                )}
              </div>

              {convertError && (
                <ErrorCard
                  title={tr("save_converter_failed", "Conversion failed")}
                  detail={convertError}
                  onDismiss={() => setConvertError(null)}
                />
              )}

              {result && (
                <ResultView
                  report={result}
                  game={game}
                  target={targetPlatform(result.direction)}
                  tr={tr}
                />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function statusLabel(status: GameStatus, tr: Tr): string {
  switch (status) {
    case "ready":
      return tr("save_converter_status_ready", "Ready");
    case "experimental":
      return tr("save_converter_status_experimental", "Experimental");
    case "wip":
      return tr("save_converter_status_wip", "In progress");
  }
}

function StatusChip({ status, tr }: { status: GameStatus; tr: Tr }) {
  const tone =
    status === "ready"
      ? "bg-[var(--color-good-soft)] text-[var(--color-good)]"
      : status === "experimental"
        ? "bg-[var(--color-warn-soft)] text-[var(--color-warn)]"
        : "bg-[var(--color-surface-3)] text-[var(--color-muted)]";
  return (
    <span
      className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${tone}`}
    >
      {statusLabel(status, tr)}
    </span>
  );
}

function GameRow({
  game,
  active,
  onSelect,
  tr,
}: {
  game: GameProfile;
  active: boolean;
  onSelect: () => void;
  tr: Tr;
}) {
  const host = useConnectionStore((s) => s.host);
  const cover = useGameCover(host ?? "", game.ps5.title_ids[0] ?? "", game.name);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={`flex w-full items-center gap-3 rounded-lg border p-2 text-left transition-colors ${
        active
          ? "border-[var(--color-gold)] bg-[var(--color-surface)]"
          : "border-transparent hover:bg-[var(--color-surface-3)]"
      }`}
    >
      <span className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-md bg-[var(--color-surface-3)] text-base font-black text-[var(--color-gold)]">
        {cover ? (
          <img src={cover} alt="" className="h-full w-full object-cover" />
        ) : (
          game.name.slice(0, 1).toUpperCase()
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{game.name}</span>
        <span className="mt-0.5 block">
          <StatusChip status={game.status} tr={tr} />
        </span>
      </span>
    </button>
  );
}

function GameMeta({ game, tr }: { game: GameProfile; tr: Tr }) {
  const parts: string[] = [];
  if (game.ps5.title_ids.length > 0) {
    parts.push(`PS5 ${game.ps5.title_ids.join(", ")}`);
  }
  if (game.pc.steam_app_id !== null) {
    parts.push(
      `${tr("save_converter_steam_app", "Steam app")} ${game.pc.steam_app_id}`,
    );
  }
  if (parts.length === 0) return null;
  return (
    <p className="mt-1 text-xs text-[var(--color-muted)]">{parts.join(" · ")}</p>
  );
}

function DirectionButton({
  from,
  to,
  active,
  onSelect,
}: {
  from: "PS5" | "PC";
  to: "PS5" | "PC";
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onSelect}
      className={`flex items-center justify-center gap-2.5 rounded-lg border px-4 py-3 text-sm font-bold transition-colors ${
        active
          ? "border-[var(--color-gold)] bg-[var(--color-gold-soft)] text-[var(--color-gold)]"
          : "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-muted)] hover:text-[var(--color-text)]"
      }`}
    >
      <span>{from}</span>
      <ArrowRight size={16} aria-hidden />
      <span>{to}</span>
    </button>
  );
}

function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4">
      <h3 className="mb-2 flex items-center gap-2.5 text-sm font-semibold">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--color-gold)] text-[11px] font-black text-[#1a1206]">
          {n}
        </span>
        {title}
      </h3>
      {children}
    </section>
  );
}

function SourceHint({
  game,
  direction,
  tr,
}: {
  game: GameProfile;
  direction: Direction;
  tr: Tr;
}) {
  if (direction === "ps5_to_pc") {
    return (
      <div className="mb-2 space-y-1 text-xs text-[var(--color-muted)]">
        <p>
          {tr(
            "save_converter_ps5_hint",
            "This needs the decrypted save files — export them on the console with a save manager such as Garlic SaveMgr (Payloads tab). A backup from the Save data tab is still sealed to your console and can't be converted.",
          )}
        </p>
        {game.ps5.save_hint && <p>{game.ps5.save_hint}</p>}
      </div>
    );
  }
  if (!game.pc.save_path) return null;
  return (
    <div className="mb-2 text-xs text-[var(--color-muted)]">
      <p>{tr("save_converter_pc_hint", "Usually found at:")}</p>
      <code className="mt-1 block break-all rounded bg-[var(--color-surface)] px-2 py-1.5">
        {game.pc.save_path}
      </code>
    </div>
  );
}

function FolderField({
  path,
  onChoose,
  disabled,
  tr,
}: {
  path: string;
  onChoose: () => void;
  disabled: boolean;
  tr: Tr;
}) {
  return (
    <div className="flex items-center gap-2">
      <code
        className={`min-w-0 flex-1 truncate rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-xs ${
          path ? "" : "text-[var(--color-muted)]"
        }`}
        title={path || undefined}
      >
        {path || tr("save_converter_no_folder", "No folder chosen")}
      </code>
      <Button
        variant="secondary"
        size="md"
        leftIcon={<FolderOpen size={14} />}
        onClick={onChoose}
        disabled={disabled}
      >
        {path
          ? tr("save_converter_change", "Change")
          : tr("save_converter_choose", "Choose folder")}
      </Button>
    </div>
  );
}

function InspectView({
  report,
  pickedDir,
  source,
  tr,
}: {
  report: InspectReport;
  pickedDir: string;
  source: "PS5" | "PC";
  tr: Tr;
}) {
  const requiredMissing = report.missing.filter((m) => m.required);
  const optionalMissing = report.missing.filter((m) => !m.required);
  return (
    <div className="mt-3 space-y-2">
      {report.save_root !== pickedDir && report.files.length > 0 && (
        <p className="text-xs text-[var(--color-muted)]">
          {tr("save_converter_found_in", "Save found in:")}{" "}
          <code className="break-all">{report.save_root}</code>
        </p>
      )}

      {(report.files.length > 0 || report.missing.length > 0) && (
        <ul className="space-y-1">
          {report.files.map((f) => (
            <li
              key={f.source}
              className="flex items-center gap-2 rounded-md bg-[var(--color-surface)] px-2.5 py-1.5 text-xs"
            >
              <Check
                size={13}
                className="shrink-0 text-[var(--color-good)]"
                aria-hidden
              />
              <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5">
                <code className="break-all">{f.source}</code>
                {f.dest !== f.source && (
                  <>
                    <ArrowRight
                      size={11}
                      className="shrink-0 text-[var(--color-muted)]"
                      aria-hidden
                    />
                    <code className="break-all">{f.dest}</code>
                  </>
                )}
                {f.label && (
                  <span className="text-[var(--color-muted)]">· {f.label}</span>
                )}
              </span>
              <span className="shrink-0 tabular-nums text-[var(--color-muted)]">
                {formatBytes(f.size)}
              </span>
            </li>
          ))}
          {requiredMissing.map((m) => (
            <li
              key={m.pattern}
              className="flex items-center gap-2 rounded-md bg-[var(--color-surface)] px-2.5 py-1.5 text-xs"
            >
              <X
                size={13}
                className="shrink-0 text-[var(--color-bad)]"
                aria-hidden
              />
              <span className="min-w-0 flex-1">
                <code className="break-all">{m.pattern}</code>
                {m.label && (
                  <span className="text-[var(--color-muted)]"> · {m.label}</span>
                )}
              </span>
              <span className="shrink-0 text-[var(--color-bad)]">
                {tr("save_converter_missing", "missing")}
              </span>
            </li>
          ))}
          {optionalMissing.map((m) => (
            <li
              key={m.pattern}
              className="flex items-center gap-2 rounded-md bg-[var(--color-surface)] px-2.5 py-1.5 text-xs text-[var(--color-muted)]"
            >
              <Minus size={13} className="shrink-0" aria-hidden />
              <span className="min-w-0 flex-1">
                <code className="break-all">{m.pattern}</code>
                {m.label && <span> · {m.label}</span>}
              </span>
              <span className="shrink-0">
                {tr("save_converter_not_present", "not in this save")}
              </span>
            </li>
          ))}
        </ul>
      )}

      {report.ignored_total > 0 && report.files.length > 0 && (
        <p className="text-xs text-[var(--color-muted)]">
          {`${report.ignored_total} ${
            report.ignored_total === 1
              ? tr(
                  "save_converter_ignored_one",
                  "other file in this folder isn't part of the game save and will be left out.",
                )
              : tr(
                  "save_converter_ignored_many",
                  "other files in this folder aren't part of the game save and will be left out.",
                )
          }`}
        </p>
      )}

      {!report.convertible && (
        <WarningCard
          title={`${tr("save_converter_blocked", "Can't convert this")} ${source} ${tr("save_converter_blocked_tail", "folder yet")}`}
          detail={
            <ul className="list-disc space-y-0.5 ps-4">
              {report.blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          }
        />
      )}
    </div>
  );
}

function ResultView({
  report,
  game,
  target,
  tr,
}: {
  report: ConvertReport;
  game: GameProfile;
  target: "PS5" | "PC";
  tr: Tr;
}) {
  const [revealError, setRevealError] = useState<string | null>(null);
  const steps = game.next_steps[report.direction];
  const count = report.files.length;
  return (
    <div className="space-y-3">
      <SuccessCard
        title={`${tr("save_converter_done", "Converted")} ${count} ${
          count === 1
            ? tr("save_converter_file", "file")
            : tr("save_converter_files", "files")
        } ${tr("save_converter_done_for", "for")} ${target}`}
        detail={
          <>
            <code className="block break-all">{report.output_dir}</code>
            <ul className="mt-2 space-y-0.5">
              {report.files.map((f) => (
                <li key={f.dest} className="flex gap-2">
                  <code className="min-w-0 flex-1 break-all">{f.dest}</code>
                  <span className="shrink-0 tabular-nums">
                    {formatBytes(f.out_size)}
                  </span>
                </li>
              ))}
            </ul>
            {revealError && (
              <p className="mt-2 text-[var(--color-bad)]">{revealError}</p>
            )}
          </>
        }
        action={
          <Button
            variant="secondary"
            leftIcon={<FolderOpen size={12} />}
            onClick={() => {
              setRevealError(null);
              saveConverterReveal(report.output_dir).catch((e) =>
                setRevealError(e instanceof Error ? e.message : String(e)),
              );
            }}
          >
            {tr("save_converter_open_folder", "Open folder")}
          </Button>
        }
      />

      {report.warnings.length > 0 && (
        <WarningCard
          title={tr("save_converter_warnings", "Worth checking")}
          detail={
            <ul className="list-disc space-y-0.5 ps-4">
              {report.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          }
        />
      )}

      {steps.length > 0 && (
        <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4">
          <h3 className="mb-2 text-sm font-semibold">
            {tr("save_converter_next", "What to do next")}
          </h3>
          <ol className="list-decimal space-y-1 ps-5 text-xs text-[var(--color-muted)]">
            {steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}
