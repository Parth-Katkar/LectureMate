const API_BASE = "http://127.0.0.1:8000";

export type ScreenshotAnalysisResult = {
  video_id: number;
  seconds: number;
  timestamp: string;
  analysis: string;
  image_base64?: string;
  mime_type?: string;
  provider: string;
  saved?: boolean;
  saved_chunks?: number;
  visual_shots_saved: number;
  visual_chunks_saved_total?: number;
  visual_chunks_embedded_total?: number;
  embedding_model?: string | null;
};

/** Capture the current frame of an uploaded video, if browser canvas access allows it. */
export function captureCurrentFrame(video: HTMLVideoElement | null): string | null {
  if (
    !video ||
    video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
    !video.videoWidth ||
    !video.videoHeight
  ) {
    return null;
  }

  try {
    const scale = Math.min(1, 1024 / video.videoWidth);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.82).split(",", 2)[1] ?? null;
  } catch {
    // The backend can extract the frame from the saved video at the requested timestamp.
    return null;
  }
}


/** Capture a user-selected browser tab/screen. Required for YouTube because its iframe
 * is cross-origin and cannot be read through canvas. The caller should invoke this
 * directly from a user click so the browser can show its sharing picker. */
export async function captureSharedScreenFrame(): Promise<string> {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error("This browser cannot capture a tab screenshot. Try an updated Chrome or Edge browser.");
  }
  let stream: MediaStream | null = null;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 1 },
      audio: false,
    });
    const track = stream.getVideoTracks()[0];
    if (!track) throw new Error("No shared screen was selected.");
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();
    await new Promise<void>((resolve, reject) => {
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) { resolve(); return; }
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error("Could not read the selected screen."));
    });
    const scale = Math.min(1, 1280 / (video.videoWidth || 1280));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round((video.videoWidth || 1280) * scale));
    canvas.height = Math.max(1, Math.round((video.videoHeight || 720) * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not prepare the screenshot.");
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.84).split(",", 2)[1] || "";
  } finally {
    stream?.getTracks().forEach((track) => track.stop());
  }
}

export async function analyzeScreenshot(
  videoId: number,
  seconds: number,
  imageBase64?: string | null,
): Promise<ScreenshotAnalysisResult> {
  const response = await fetch(`${API_BASE}/api/videos/${videoId}/visual-analysis`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ seconds, image_base64: imageBase64 || null }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.detail || `Could not analyze the current screenshot (HTTP ${response.status})`);
  }
  return data as ScreenshotAnalysisResult;
}
