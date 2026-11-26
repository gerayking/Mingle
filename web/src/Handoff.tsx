import { useEffect, useState } from "react";
import { type AgentView, api, HANDOFF_MAX_BYTES, type HandoffView } from "./api.ts";
import { errorText, useI18n } from "./i18n.ts";
import { onEscape } from "./shortcuts.ts";
import {
  Button,
  CheckIcon,
  CopyIcon,
  copyText,
  Group,
  GroupRow,
  HandoffIcon,
  relativeTime,
  Section,
  Segmented,
  Spinner,
  Step,
  Steps,
  shortDateTime,
  Textarea,
} from "./ui.tsx";

/** The settings list shows the latest few; the activity feed has the rest. */
const RECENT = 5;

const utf8 = new TextEncoder();

export function kilobytes(bytes: number): string {
  return `${Math.max(0.1, Math.round(bytes / 102.4) / 10)} KB`;
}

/** A handoff's first line of text, without Markdown heading or list marks, as its title. */
export function handoffTitle(body: string): string {
  const line = body.split("\n").find((l) => l.trim()) ?? "";
  return line.replace(/^\s*(?:#+|[-*>]|\d+[.)])\s*/u, "").trim();
}

/** Where a waiting handoff stands, in words: the agent's state decides when it reads it. */
export function HandoffState({ handoff, agent }: { handoff: HandoffView; agent: AgentView }) {
  const { t } = useI18n();
  if (handoff.state === "delivered") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-line2 px-2 py-0.5 text-caption whitespace-nowrap text-green">
        {t("handoff.sent", { name: agent.name })}
      </span>
    );
  }
  const why =
    agent.status === "paused"
      ? t("handoff.waitingPaused", { name: agent.name })
      : agent.status === "thinking" || agent.status === "working"
        ? t("handoff.waitingBusy", { name: agent.name })
        : t("handoff.waiting");
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-line bg-amber-tint px-2 py-0.5 text-caption whitespace-nowrap text-amber">
      {why}
    </span>
  );
}

/**
 * Agent settings → Handoff (docs/spec.md 4.12): copy a prompt for another conversation to hand off
 * with a command, or paste what one wrote. Opens in place; the latest handoffs are listed below.
 */
export function HandoffSection({
  agent,
  handoffs,
  onSent,
}: {
  agent: AgentView;
  handoffs: HandoffView[] | null;
  onSent: () => void;
}) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"copy" | "paste">(agent.remote ? "paste" : "copy");
  const recent = (handoffs ?? []).slice(0, RECENT);
  return (
    <Section title={t("handoff.title")}>
      <Group>
        <GroupRow className="flex-wrap">
          <span className="flex min-w-0 flex-1 flex-col">
            <span>{t("handoff.rowTitle")}</span>
            <span className="text-caption text-ink2">{t("handoff.rowBody", { name: agent.name })}</span>
          </span>
          {open ? null : (
            <Button small onClick={() => setOpen(true)}>
              {t("handoff.open")}
            </Button>
          )}
        </GroupRow>
        {open ? (
          // biome-ignore lint/a11y/noStaticElementInteractions: Escape closes the panel it belongs to
          <div className="rise flex flex-col gap-4 px-4 py-4" onKeyDown={onEscape(() => setOpen(false))}>
            <Segmented
              label={t("handoff.title")}
              value={mode}
              onChange={setMode}
              options={[
                { value: "copy", label: t("handoff.tabCopy") },
                { value: "paste", label: t("handoff.tabPaste") },
              ]}
            />
            {agent.remote && mode === "copy" ? <p className="text-small text-ink2">{t("ssh.handoffHint")}</p> : null}
            {mode === "copy" ? (
              <CopyPrompt agent={agent} handoffs={handoffs} onClose={() => setOpen(false)} />
            ) : (
              <PasteHandoff agent={agent} onSent={onSent} onClose={() => setOpen(false)} />
            )}
          </div>
        ) : null}
        {recent.map((h) => (
          <GroupRow key={h.id}>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-small" title={handoffTitle(h.body)}>
                {handoffTitle(h.body) || t("handoff.untitled")}
              </span>
              <span className="truncate text-caption text-ink2">
                {[
                  shortDateTime(h.createdAt, locale),
                  t(h.via === "paste" ? "handoff.viaPaste" : "handoff.viaCommand"),
                  kilobytes(h.size),
                ].join(" · ")}
              </span>
            </span>
            <HandoffState handoff={h} agent={agent} />
          </GroupRow>
        ))}
      </Group>
    </Section>
  );
}

function CopyPrompt({
  agent,
  handoffs,
  onClose,
}: {
  agent: AgentView;
  handoffs: HandoffView[] | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [prompt, setPrompt] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [full, setFull] = useState(false);
  /** When the prompt was copied: a handoff made after it is the one this panel waits for. */
  const [copiedAt, setCopiedAt] = useState<number | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  useEffect(() => {
    let live = true;
    api.handoffPrompt(agent.id).then(
      (r) => live && setPrompt(r.text),
      (e) => live && setFailed(errorText(t, e)),
    );
    return () => {
      live = false;
    };
  }, [agent.id, t]);
  const arrived =
    copiedAt === null ? undefined : (handoffs ?? []).find((h) => h.via === "command" && h.createdAt >= copiedAt);
  const received = Boolean(arrived);
  const step = received ? 3 : copiedAt !== null ? 2 : 1;
  const state = (n: number) => (n < step || received ? "done" : n === step ? "now" : "later");
  return (
    <div className="flex flex-col gap-4">
      <Steps>
        <Step n={1} state={state(1)} title={t("handoff.step1")} hint={t("handoff.step1Hint")} />
        <Step n={2} state={state(2)} title={t("handoff.step2")} hint={t("handoff.step2Hint", { name: agent.name })} />
        <Step n={3} state={state(3)} title={t("handoff.step3", { name: agent.name })} />
      </Steps>
      {failed ? <p className="text-small text-red">{failed}</p> : null}
      {prompt === null && !failed ? (
        <p className="flex items-center gap-2 text-small text-ink2">
          <Spinner /> {t("handoff.loading")}
        </p>
      ) : null}
      {prompt !== null ? (
        <pre
          className={`selectable relative overflow-hidden rounded-control border border-line2 bg-bg2 px-3.5 py-3 font-mono text-caption leading-[18px] whitespace-pre-wrap wrap-anywhere text-ink ${full ? "" : "max-h-[212px] after:absolute after:inset-x-0 after:bottom-0 after:h-14 after:bg-gradient-to-b after:from-transparent after:to-bg2"}`}
        >
          {prompt}
        </pre>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {copiedAt === null ? (
          <Button
            key="copy"
            variant="primary"
            disabled={prompt === null}
            onClick={async () => {
              if (prompt === null) return;
              const ok = await copyText(prompt);
              setCopyFailed(!ok);
              if (ok) setCopiedAt(Date.now());
            }}
          >
            <CopyIcon />
            {t("handoff.copy")}
          </Button>
        ) : (
          <Button
            key="copied"
            onClick={async () => {
              if (prompt !== null) await copyText(prompt);
            }}
          >
            <CheckIcon className="text-green" />
            {t("handoff.copied")}
          </Button>
        )}
        {prompt !== null ? (
          <Button variant="ghost" onClick={() => setFull((v) => !v)}>
            {full ? t("handoff.showLess") : t("handoff.showAll")}
          </Button>
        ) : null}
        <span className="min-w-0 flex-1" />
        {received ? (
          <span role="status" className="flex items-center gap-1.5 text-small text-green">
            <CheckIcon />
            {arrived?.state === "delivered"
              ? t("handoff.received", { name: agent.name })
              : agent.status === "paused"
                ? t("handoff.receivedPaused", { name: agent.name })
                : t("handoff.receivedBusy", { name: agent.name })}
          </span>
        ) : copiedAt !== null ? (
          <span role="status" className="flex items-center gap-2 text-small text-ink2">
            <Spinner />
            {t("handoff.waitingCommand")}
          </span>
        ) : null}
        <Button variant="ghost" onClick={onClose}>
          {t("handoff.close")}
        </Button>
      </div>
      {copyFailed ? <p className="text-caption text-red">{t("handoff.copyFailed")}</p> : null}
    </div>
  );
}

function PasteHandoff({ agent, onSent, onClose }: { agent: AgentView; onSent: () => void; onClose: () => void }) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const size = utf8.encode(text.trim()).byteLength;
  const over = size > HANDOFF_MAX_BYTES;
  const max = kilobytes(HANDOFF_MAX_BYTES);
  const send = async () => {
    setPending(true);
    setResult(null);
    try {
      const { state } = await api.handoff(agent.id, text);
      setText("");
      setResult({
        ok: true,
        text:
          state === "paused"
            ? t("handoff.sentPaused", { name: agent.name })
            : state === "busy"
              ? t("handoff.sentBusy", { name: agent.name })
              : t("handoff.sent", { name: agent.name }),
      });
      onSent();
    } catch (error) {
      setResult({ ok: false, text: errorText(t, error) });
    } finally {
      setPending(false);
    }
  };
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <p className="text-caption text-ink2">{t("handoff.pasteHint")}</p>
      <Textarea
        autoFocus
        rows={8}
        aria-label={t("handoff.tabPaste")}
        placeholder={t("handoff.pastePlaceholder")}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setResult(null);
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <span className={`min-w-0 flex-1 text-caption ${over ? "text-red" : "text-ink2"}`}>
          {result
            ? null
            : over
              ? t("handoff.tooLarge", { size: kilobytes(size), max })
              : size > 0
                ? t("handoff.size", { size: kilobytes(size), max })
                : null}
        </span>
        <Button variant="ghost" disabled={pending} onClick={onClose}>
          {t("handoff.cancel")}
        </Button>
        <Button type="submit" variant="primary" disabled={pending || size === 0 || over}>
          {t("handoff.send", { name: agent.name })}
        </Button>
      </div>
      {result ? (
        <p role="status" className={`flex items-center gap-1.5 text-small ${result.ok ? "text-green" : "text-red"}`}>
          {result.ok ? <CheckIcon /> : null}
          {result.text}
        </p>
      ) : null}
    </form>
  );
}

/** One handoff in the activity feed: who handed what, how big, and whether the agent has it. */
export function HandoffItem({ handoff, agent }: { handoff: HandoffView; agent: AgentView }) {
  const { t, locale } = useI18n();
  const [more, setMore] = useState(false);
  const long = handoff.body.length > 160 || handoff.body.split("\n").length > 2;
  return (
    <div className="flex gap-3 px-4 py-3">
      <span className="flex size-5 shrink-0 items-center justify-center text-ink2">
        <HandoffIcon />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-baseline gap-2 text-small">
          <span className="max-w-[60%] shrink-0 truncate font-semibold">
            {t("handoff.feedTitle", { name: agent.name })}
          </span>
          <span className="min-w-0 flex-1 truncate text-ink3">
            {`${t(handoff.via === "paste" ? "handoff.viaPaste" : "handoff.viaCommand")} · ${kilobytes(handoff.size)}`}
          </span>
          <span className="shrink-0 whitespace-nowrap text-caption text-ink3">
            {relativeTime(handoff.createdAt, locale)}
          </span>
        </div>
        <p
          className={`selectable whitespace-pre-wrap wrap-anywhere text-ink2 ${more ? "max-h-[480px] overflow-y-auto" : "line-clamp-2"}`}
        >
          {handoff.body}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <HandoffState handoff={handoff} agent={agent} />
          {long ? (
            <button type="button" className="text-small text-accent hover:underline" onClick={() => setMore((v) => !v)}>
              {more ? t("handoff.less") : t("handoff.more")}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
