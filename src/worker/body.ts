// The one way a route reads a request body.
// celld's isolate heap is ~400 MB (far below the container's limit): one buffered 150 MB body (req.json()) killed the platform
// for everyone. So the body is read as a stream and cut at MAX_BODY_BYTES, whether it declares Content-Length or comes chunked.
// 8 MB: the largest real publish (artifacts/shared-list) is ~73 KB of JSON; a room holds at most 1 MB.
import { UserError } from "./platform";

export const MAX_BODY_BYTES = 8 * 1024 * 1024;
const tooLarge = () => new UserError(413, `request body over ${MAX_BODY_BYTES} bytes`);

export async function readJson(req: Request): Promise<any> {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) throw tooLarge();
  const dec = new TextDecoder();
  let text = "", n = 0;
  const reader = req.body?.getReader();
  if (reader) for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > MAX_BODY_BYTES) { await reader.cancel(); throw tooLarge(); }
    text += dec.decode(value, { stream: true });
  }
  try { return JSON.parse(text + dec.decode()); } catch { throw new UserError(400, "JSON body expected"); }
}
