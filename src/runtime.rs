//! 有界异步执行；超时覆盖响应头和响应体的整个读取过程。
use std::{
    future::{Future, poll_fn},
    task::Poll,
    time::Duration,
};

pub fn timeout<T>(
    ms: u64,
    future: impl Future<Output = T>,
) -> impl Future<Output = Result<T, &'static str>> {
    race(future, worker::Delay::from(Duration::from_millis(ms)))
}

fn race<T>(
    future: impl Future<Output = T>,
    timer: impl Future<Output = ()>,
) -> impl Future<Output = Result<T, &'static str>> {
    // 在构造组合器时装箱，避免嵌套 async 状态在未优化 Wasm 中耗尽栈空间。
    let mut future = Box::pin(future);
    let mut timer = Box::pin(timer);
    poll_fn(move |cx| {
        if timer.as_mut().poll(cx).is_ready() {
            return Poll::Ready(Err("操作超时，执行结果可能尚未确认，请刷新状态"));
        }
        future.as_mut().poll(cx).map(Ok)
    })
}

/// 极简 `join`：两个 future 都完成后返回各自结果。
pub fn join2<A, B, FA, FB>(fa: FA, fb: FB) -> impl Future<Output = (A, B)>
where
    FA: std::future::Future<Output = A>,
    FB: std::future::Future<Output = B>,
{
    use std::task::Poll;

    let mut fa = Box::pin(fa);
    let mut fb = Box::pin(fb);
    let mut out_a: Option<A> = None;
    let mut out_b: Option<B> = None;

    std::future::poll_fn(move |cx| {
        if out_a.is_none()
            && let Poll::Ready(value) = fa.as_mut().poll(cx)
        {
            out_a = Some(value);
        }
        if out_b.is_none()
            && let Poll::Ready(value) = fb.as_mut().poll(cx)
        {
            out_b = Some(value);
        }
        match (out_a.is_some(), out_b.is_some()) {
            (true, true) => {
                Poll::Ready((out_a.take().expect("已就绪"), out_b.take().expect("已就绪")))
            }
            _ => Poll::Pending,
        }
    })
}

/// 超时或外层任务取消时中止底层 fetch，避免请求在后台继续占用连接。
struct AbortOnDrop(Option<worker::AbortController>);
impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        if let Some(controller) = self.0.take() {
            controller.abort();
        }
    }
}

pub async fn fetch_text(request: worker::Request, ms: u64) -> Result<(u16, String), String> {
    let controller = AbortOnDrop(Some(worker::AbortController::default()));
    timeout(ms, async {
        let mut response = worker::Fetch::Request(request)
            .send_with_signal(
                &controller
                    .0
                    .as_ref()
                    .expect("controller exists until drop")
                    .signal(),
            )
            .await
            .map_err(|e| e.to_string())?;
        let status = response.status_code();
        let body = response.text().await.map_err(|e| e.to_string())?;
        Ok((status, body))
    })
    .await
    .map_err(str::to_string)?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::pin::pin;
    use std::task::{Context, Waker};

    #[test]
    fn stalled_operation_is_cancelled_and_ready_operation_completes() {
        let mut cx = Context::from_waker(Waker::noop());
        let mut stalled = pin!(race(std::future::pending::<()>(), std::future::ready(())));
        assert!(matches!(
            stalled.as_mut().poll(&mut cx),
            Poll::Ready(Err(_))
        ));
        let mut ready = pin!(race(std::future::ready(42), std::future::pending()));
        assert_eq!(ready.as_mut().poll(&mut cx), Poll::Ready(Ok(42)));
    }
}
