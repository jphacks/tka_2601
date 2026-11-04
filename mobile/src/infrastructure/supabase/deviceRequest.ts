// 通信が応答しなくても、本体登録・確認の操作を再び使えるようにする。
export async function deviceRequest<T>(request: (signal: AbortSignal) => PromiseLike<T>, timeoutMs = 10000): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('本体の応答を確認できませんでした。'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([request(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
