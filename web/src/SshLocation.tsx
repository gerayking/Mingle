import { type ReactNode, useEffect, useRef, useState } from "react";
import { ApiError, api, type SshHost } from "./api.ts";
import { errorText, type MessageKey, useI18n } from "./i18n.ts";
import { RemoteInstall } from "./RemoteInstall.tsx";
import { Button, Field, Input, MoreMenu, Select, Spinner } from "./ui.tsx";

/**
 * Where a new agent will run, and whether an SSH host is being set up there:
 * this computer, a host being added, a prepared host, or a prepared host being prepared again.
 */
export interface Place {
  /** A prepared SSH host's id; null is this computer. */
  host: string | null;
  /** The setup is open: adding a host when `host` is null, preparing it again otherwise. */
  setup: boolean;
}

/** The SSH hosts prepared so far. A failed read leaves the list empty: this computer still works. */
export function useSshHosts() {
  const [hosts, setHosts] = useState<SshHost[]>([]);
  useEffect(() => {
    let alive = true;
    void api
      .sshHosts()
      .then((items) => {
        if (alive) setHosts(items);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  const remember = (ready: SshHost) => setHosts((items) => [...items.filter((item) => item.id !== ready.id), ready]);
  return { hosts, remember };
}

/**
 * A sentence with the run location as a word in it: "The harness on [this computer ▾] that…".
 * Running elsewhere is rare, so it stays a word in the hint until someone opens it.
 */
export function LocationSentence({
  sentence,
  place,
  hosts,
  disabled,
  onChange,
}: {
  /** A message with a {location} placeholder. */
  sentence: MessageKey;
  place: Place;
  hosts: SshHost[];
  /** While a host is being set up the word is plain text: leaving would orphan the setup. */
  disabled: boolean;
  onChange: (place: Place) => void;
}) {
  const { t } = useI18n();
  const label = (host: SshHost) =>
    hosts.some((other) => other !== host && other.host === host.host) ? `${host.host} · ${host.home}` : host.host;
  const selected = hosts.find((host) => host.id === place.host);
  const adding = place.host === null && place.setup;
  const word = adding ? t("ssh.newHost") : selected ? label(selected) : t("ssh.localInline");
  // The translator spaces the word against Chinese text; split around it to make it a control.
  const text = t(sentence, { location: word });
  const at = text.indexOf(word);
  return (
    <>
      {text.slice(0, at)}
      {disabled ? (
        <span className="text-ink2">{word}</span>
      ) : (
        <MoreMenu
          label={t("ssh.location")}
          trigger={<span className="wrap-anywhere">{word}</span>}
          items={[
            {
              label: t("ssh.local"),
              checked: place.host === null && !adding,
              onSelect: () => onChange({ host: null, setup: false }),
            },
            ...hosts.map((host) => ({
              label: label(host),
              checked: place.host === host.id,
              onSelect: () => onChange({ host: host.id, setup: false }),
            })),
            { label: t("ssh.add"), checked: adding, onSelect: () => onChange({ host: null, setup: true }) },
          ]}
        />
      )}
      {text.slice(at + word.length)}
    </>
  );
}

/**
 * The setup, one state at a time. Every state but `idle` is waiting on Mingle, and each has a
 * way out: a request settles, a running installation ends or loses its progress, and a lost
 * one can be asked again. Success leaves the machine through `onReady`.
 */
type Setup =
  | { kind: "idle"; error?: string; offerInstall?: boolean }
  | { kind: "preparing" }
  | { kind: "starting" }
  | { kind: "installing"; id: string; phase: "installing" | "preparing"; lost: boolean; attempt: number };

/**
 * Prepares an SSH host in place: a new one (`host` absent), or a known one again after it restarted.
 * Calls `onReady` with the host once remote Mingle answers.
 */
export function SshSetup({
  host: known,
  disabled,
  onBusy,
  onReady,
  onCancel,
  lead,
}: {
  host?: SshHost;
  /** What the card opens with, in place of what running remotely means. */
  lead?: ReactNode;
  disabled: boolean;
  onBusy?: (busy: boolean) => void;
  onReady: (host: SshHost) => void;
  onCancel?: () => void;
}) {
  const { t } = useI18n();
  const [target, setTarget] = useState("");
  const [home, setHome] = useState("~/.mingle-remote");
  const [setup, setSetup] = useState<Setup>({ kind: "idle" });
  const [config, setConfig] = useState<{ hosts: string[]; incomplete: boolean } | null>(null);
  const [configLoading, setConfigLoading] = useState(false);
  const [configFailed, setConfigFailed] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const busy = setup.kind !== "idle";
  const alive = useRef(true);
  const ready = useRef(onReady);
  ready.current = onReady;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => onBusy?.(busy), [busy, onBusy]);
  useEffect(() => () => onBusy?.(false), [onBusy]);

  const jobId = setup.kind === "installing" && !setup.lost ? setup.id : null;
  const attempt = setup.kind === "installing" ? setup.attempt : 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new attempt polls the same job again.
  useEffect(() => {
    if (!jobId) return;
    let current = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await api.sshInstallation(jobId as string);
        if (!current) return;
        if (next.state === "running") {
          setSetup((s) => (s.kind === "installing" ? { ...s, phase: next.phase } : s));
          timer = setTimeout(() => void poll(), 750);
        } else if (next.state === "done" && next.result) ready.current(next.result);
        else
          setSetup({
            kind: "idle",
            offerInstall: true,
            error: errorText(t, new ApiError(next.error ?? "ssh_install_failed", "", 400)),
          });
      } catch (e) {
        if (!current) return;
        if (e instanceof ApiError && e.code === "ssh_install_missing")
          setSetup({ kind: "idle", offerInstall: true, error: errorText(t, e) });
        // The installation may still be running: say its progress is unknown, never that it failed.
        else setSetup((s) => (s.kind === "installing" ? { ...s, lost: true } : s));
      }
    }
    void poll();
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [jobId, attempt, t]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh explicitly invalidates the file snapshot.
  useEffect(() => {
    if (known) return;
    let current = true;
    setConfigLoading(true);
    setConfigFailed(false);
    void api
      .sshConfig()
      .then((result) => {
        if (current) setConfig(result);
      })
      .catch(() => {
        if (current) setConfigFailed(true);
      })
      .finally(() => {
        if (current) setConfigLoading(false);
      });
    return () => {
      current = false;
    };
  }, [known, refresh]);

  /** A different host starts over: nothing learned about the last one applies. */
  function changeTarget(next: string) {
    setTarget(next);
    setSetup({ kind: "idle" });
  }
  const host = known?.host ?? target.trim();
  const dir = known?.home ?? home.trim();
  async function install() {
    setSetup({ kind: "starting" });
    try {
      const job = await api.installSshHost(host, dir);
      if (alive.current) setSetup({ kind: "installing", id: job.id, phase: job.phase, lost: false, attempt: 0 });
    } catch (e) {
      if (alive.current) setSetup({ kind: "idle", offerInstall: true, error: errorText(t, e) });
    }
  }
  async function prepare() {
    setSetup({ kind: "preparing" });
    try {
      const result = await api.addSshHost(host, dir);
      if (alive.current) ready.current(result);
    } catch (e) {
      if (alive.current)
        setSetup({
          kind: "idle",
          error: errorText(t, e),
          offerInstall: e instanceof ApiError && e.code === "ssh_node_missing",
        });
    }
  }
  const incomplete = !host || !dir;
  return (
    <div className="rise flex flex-col gap-3 rounded-control border border-line bg-bg2 p-4">
      <p className="text-small text-ink2">{lead ?? t("ssh.description")}</p>
      {!known ? (
        <>
          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <Field label={t("ssh.config")}>
                <Select
                  value={config?.hosts.includes(target) ? target : ""}
                  disabled={disabled || busy || configLoading || !config?.hosts.length}
                  onChange={(e) => changeTarget(e.target.value)}
                >
                  <option value="">{t(configLoading ? "ssh.configLoading" : "ssh.configChoose")}</option>
                  {config?.hosts.map((alias) => (
                    <option key={alias} value={alias}>
                      {alias}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Button disabled={disabled || busy || configLoading} onClick={() => setRefresh((n) => n + 1)}>
              {t("ssh.configRefresh")}
            </Button>
          </div>
          {!configLoading && (configFailed || config?.incomplete) ? (
            <p role="status" className="text-caption text-amber">
              {t(configFailed ? "ssh.configFailed" : "ssh.configIncomplete")}
            </p>
          ) : !configLoading && config?.hosts.length === 0 ? (
            <p className="text-caption text-ink2">{t("ssh.configEmpty")}</p>
          ) : null}
          <Field label={t("ssh.target")} hint={t("ssh.targetHint")}>
            <Input
              value={target}
              disabled={busy}
              onChange={(e) => changeTarget(e.target.value)}
              placeholder="user@host"
              autoComplete="off"
            />
          </Field>
          <Field label={t("ssh.home")}>
            <Input value={home} disabled={busy} onChange={(e) => setHome(e.target.value)} autoComplete="off" />
          </Field>
          <p className="text-caption text-ink2">{t("ssh.requirements")}</p>
        </>
      ) : (
        <p className="text-caption text-ink2">{t("ssh.reconnectHint")}</p>
      )}
      {setup.kind === "idle" && setup.error ? (
        <p role="alert" className="text-small text-red">
          {setup.error}
        </p>
      ) : null}
      <RemoteInstall
        key={host}
        required={setup.kind === "installing" || (setup.kind === "idle" && Boolean(setup.offerInstall))}
        disabled={disabled || busy || incomplete}
        onInstall={() => void install()}
      />
      {setup.kind === "installing" ? (
        <div role="status" className="flex flex-col gap-2 text-small text-ink2">
          {setup.lost ? (
            <>
              <p>{t("ssh.installPollFailed")}</p>
              <Button
                small
                className="self-start"
                onClick={() => setSetup({ ...setup, lost: false, attempt: setup.attempt + 1 })}
              >
                {t("ssh.installPollRetry")}
              </Button>
            </>
          ) : (
            <>
              <p className="flex items-center gap-2">
                <Spinner />
                {t(setup.phase === "installing" ? "ssh.installing" : "ssh.preparing")}
              </p>
              <p className="text-caption">{t("ssh.installKeepOpen")}</p>
            </>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Button disabled={disabled || busy || incomplete} onClick={() => void prepare()}>
            {setup.kind === "preparing" ? (
              <>
                <Spinner />
                {t("ssh.preparing")}
              </>
            ) : (
              t(known ? "ssh.reconnect" : "ssh.prepare")
            )}
          </Button>
          {onCancel ? (
            <Button variant="ghost" disabled={busy} onClick={onCancel}>
              {t("create.cancel")}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}
