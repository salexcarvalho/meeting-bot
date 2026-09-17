import { useCallback, useRef, useState, type ReactNode } from "react";
import { ImageUp, Trash2 } from "lucide-react";
import type { MeResponse } from "@meeting-bot/contracts";
import { api, errorMessage } from "../../api";
import { initials } from "../../components/shell/Sidebar";
import { useToast } from "../../components/Toast";
import { useRefreshSession } from "../../session";

export type SetMe = (me: MeResponse) => void;

/** PATCH/PUT/DELETE que devolvem o /me atualizado; atualiza a tela e a sessão. */
export function useMeMutation(setMe: SetMe) {
  const toast = useToast();
  const refreshSession = useRefreshSession();
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async (path: string, opts: { method: string; json?: unknown; form?: FormData }, success: string) => {
      setBusy(true);
      try {
        const me = await api<MeResponse>(path, opts);
        setMe(me);
        toast(success);
        void refreshSession();
        return true;
      } catch (err) {
        toast(errorMessage(err), "error");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [setMe, toast, refreshSession],
  );
  return { busy, run };
}

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

export function ImageField({
  label,
  name,
  src,
  busy,
  onUpload,
  onRemove,
  hint,
}: {
  label: string;
  name: string;
  src: string | null;
  busy: boolean;
  onUpload: (file: File) => void;
  onRemove: () => void;
  hint?: ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null);
  const toast = useToast();
  return (
    <div className="image-field">
      <span className="avatar avatar-lg" aria-hidden="true">
        {src ? <img src={src} alt="" /> : initials(name)}
      </span>
      <div className="stack" style={{ gap: 6 }}>
        <strong className="small">{label}</strong>
        <div className="row">
          <button type="button" className="small" disabled={busy} onClick={() => input.current?.click()}>
            <ImageUp aria-hidden="true" /> {src ? "Trocar" : "Enviar"} imagem
          </button>
          {src && (
            <button type="button" className="small danger" disabled={busy} onClick={onRemove}>
              <Trash2 aria-hidden="true" /> Remover
            </button>
          )}
        </div>
        <span className="field-hint">{hint ?? "PNG, JPEG ou WebP, até 2 MB."}</span>
        <input
          ref={input}
          type="file"
          accept={IMAGE_TYPES.join(",")}
          hidden
          aria-label={label}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            if (!IMAGE_TYPES.includes(file.type)) return toast("Use uma imagem PNG, JPEG ou WebP.", "error");
            if (file.size > MAX_IMAGE_BYTES) return toast("A imagem passa de 2 MB.", "error");
            onUpload(file);
          }}
        />
      </div>
    </div>
  );
}

export function fileForm(file: File | Blob, filename: string): FormData {
  const form = new FormData();
  form.append("file", file, filename);
  return form;
}

export function SaveBar({ busy, dirty }: { busy: boolean; dirty: boolean }) {
  return (
    <div className="save-bar">
      {dirty && <span className="small muted">Alterações não salvas</span>}
      <button className="primary" disabled={busy || !dirty}>
        {busy ? "Salvando…" : "Salvar"}
      </button>
    </div>
  );
}
