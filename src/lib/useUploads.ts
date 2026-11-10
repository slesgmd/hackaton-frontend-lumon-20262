import { useCallback, useEffect, useRef, useState } from "react";
import { isImageFile, loadImage, renderIncident, type PreparedImage } from "./imageTools";
import { UploadSession } from "./uploader";
import type { MediaPurpose } from "./types";

export type ItemStatus = "preparing" | "ticket" | "uploading" | "confirming" | "done" | "error" | "canceled";

export interface UploadItem {
  id: string;
  name: string;
  previewUrl: string;
  status: ItemStatus;
  /** 0 a 1, progreso real de la subida al storage. */
  progress: number;
  error: string | null;
  mediaId: number | null;
  /** true si Reintentar tiene sentido (la imagen ya está preparada). */
  retryable: boolean;
}

interface Internal {
  session?: UploadSession;
  controller?: AbortController;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Error inesperado.";
}

export function isBusy(item: UploadItem): boolean {
  return item.status === "preparing" || item.status === "ticket" || item.status === "uploading" || item.status === "confirming";
}

/** Subidas en paralelo, cada una con su progreso, su cancelar y su reintentar. */
export function useUploads(purpose: MediaPurpose, max: number) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const itemsRef = useRef<UploadItem[]>([]);
  itemsRef.current = items;
  const internals = useRef(new Map<string, Internal>());

  const patch = useCallback((id: string, changes: Partial<UploadItem>): void => {
    setItems((current) => current.map((item) => (item.id === id ? { ...item, ...changes } : item)));
  }, []);

  const start = useCallback(
    async (id: string): Promise<void> => {
      const record = internals.current.get(id);
      if (!record?.session) return;
      const controller = new AbortController();
      record.controller = controller;
      patch(id, { status: "ticket", progress: 0, error: null });
      try {
        const media = await record.session.run(
          (stage) => patch(id, { status: stage === "ticket" ? "ticket" : stage === "uploading" ? "uploading" : "confirming" }),
          (progress) => patch(id, { progress: progress.total > 0 ? progress.loaded / progress.total : 0 }),
          controller.signal,
        );
        patch(id, { status: "done", progress: 1, mediaId: media.mediaId, error: null });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") patch(id, { status: "canceled", progress: 0 });
        else patch(id, { status: "error", error: messageOf(error) });
      }
    },
    [patch],
  );

  const addPrepared = useCallback(
    (prepared: PreparedImage, name: string, previewUrl: string): string => {
      const id = crypto.randomUUID();
      internals.current.set(id, { session: new UploadSession(purpose, prepared) });
      setItems((current) => [
        ...current,
        { id, name, previewUrl, status: "ticket", progress: 0, error: null, mediaId: null, retryable: true },
      ]);
      void start(id);
      return id;
    },
    [purpose, start],
  );

  const add = useCallback(
    async (files: File[]): Promise<void> => {
      const room = Math.max(0, max - itemsRef.current.length);
      await Promise.all(
        files.slice(0, room).map(async (file) => {
          const id = crypto.randomUUID();
          const previewUrl = URL.createObjectURL(file);
          internals.current.set(id, {});
          setItems((current) => [
            ...current,
            { id, name: file.name, previewUrl, status: "preparing", progress: 0, error: null, mediaId: null, retryable: false },
          ]);
          try {
            if (!isImageFile(file)) throw new Error("Este archivo no es una imagen.");
            const image = await loadImage(file);
            const prepared = await renderIncident(image);
            internals.current.set(id, { session: new UploadSession(purpose, prepared) });
            patch(id, { retryable: true });
            void start(id);
          } catch (error) {
            patch(id, { status: "error", error: messageOf(error) });
          }
        }),
      );
    },
    [max, patch, purpose, start],
  );

  const cancel = useCallback((id: string): void => {
    internals.current.get(id)?.controller?.abort();
  }, []);

  const retry = useCallback(
    (id: string): void => {
      void start(id);
    },
    [start],
  );

  const remove = useCallback((id: string): void => {
    internals.current.get(id)?.controller?.abort();
    internals.current.delete(id);
    setItems((current) => {
      const target = current.find((item) => item.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return current.filter((item) => item.id !== id);
    });
  }, []);

  const reset = useCallback((): void => {
    for (const record of internals.current.values()) record.controller?.abort();
    internals.current.clear();
    setItems((current) => {
      for (const item of current) URL.revokeObjectURL(item.previewUrl);
      return [];
    });
  }, []);

  useEffect(() => {
    const store = internals.current;
    return () => {
      for (const record of store.values()) record.controller?.abort();
      for (const item of itemsRef.current) URL.revokeObjectURL(item.previewUrl);
    };
  }, []);

  return { items, add, addPrepared, cancel, retry, remove, reset };
}
