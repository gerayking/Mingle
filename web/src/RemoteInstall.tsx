import { useState } from "react";
import { useI18n } from "./i18n.ts";
import { REMOTE_INSTALL_COMMAND, REMOTE_INSTALL_SOURCE } from "./remote-install.ts";
import { Button, copyText, LinkButton } from "./ui.tsx";

export function RemoteInstall({
  required,
  disabled,
  onInstall,
}: {
  required: boolean;
  disabled: boolean;
  onInstall: () => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [manual, setManual] = useState(false);
  if (!open && !required)
    return (
      <Button variant="ghost" small className="self-start" onClick={() => setOpen(true)}>
        {t("ssh.installOpen")}
      </Button>
    );
  return (
    <div className="min-w-0 rounded-control border border-line bg-bg p-3 flex flex-col gap-3">
      <p className="text-small font-medium">{t("ssh.installTitle")}</p>
      <p className="text-small text-ink2">{t("ssh.installAutoHint")}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" disabled={disabled} onClick={onInstall}>
          {t("ssh.installRun")}
        </Button>
        <LinkButton small href={REMOTE_INSTALL_SOURCE}>
          {t("ssh.installSource")}
        </LinkButton>
      </div>
      <Button variant="ghost" small className="self-start" onClick={() => setManual(!manual)} aria-expanded={manual}>
        {t("ssh.installManual")}
      </Button>
      {manual ? (
        <>
          <p className="text-small text-ink2">{t("ssh.installHint")}</p>
          <pre className="selectable whitespace-pre-wrap break-all rounded-small bg-bg2 p-2 text-caption">
            {REMOTE_INSTALL_COMMAND}
          </pre>
          <Button
            small
            className="self-start"
            onClick={async () => {
              const ok = await copyText(REMOTE_INSTALL_COMMAND);
              setCopied(ok);
              setCopyFailed(!ok);
            }}
          >
            {t(copied ? "ssh.installCopied" : "ssh.installCopy")}
          </Button>
          {copyFailed ? (
            <p role="status" className="text-small text-red">
              {t("ssh.installCopyFailed")}
            </p>
          ) : null}
          <p className="text-caption text-ink2">{t("ssh.installAfter")}</p>
        </>
      ) : null}
    </div>
  );
}
