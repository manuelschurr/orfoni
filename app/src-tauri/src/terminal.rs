use russh::client::Msg;
use russh::{Channel, ChannelMsg};
use tokio::sync::{mpsc, oneshot};

const OUTPUT_QUEUE: usize = 64;

enum Input {
    Data(Vec<u8>),
    Resize { cols: u32, rows: u32 },
    Close,
}

pub struct TerminalChannel {
    pub input: TerminalInput,
    pub output: mpsc::Receiver<Vec<u8>>,
}

#[derive(Clone)]
pub struct TerminalInput(mpsc::UnboundedSender<Input>);

impl TerminalInput {
    pub fn write(&self, data: Vec<u8>) {
        let _ = self.0.send(Input::Data(data));
    }

    pub fn resize(&self, cols: u32, rows: u32) {
        let _ = self.0.send(Input::Resize { cols, rows });
    }

    pub fn close(&self) {
        let _ = self.0.send(Input::Close);
    }
}

impl TerminalChannel {
    pub(crate) fn spawn(channel: Channel<Msg>) -> TerminalChannel {
        let (mut read, write) = channel.split();
        let (input, mut inputs) = mpsc::unbounded_channel();
        let (chunks, output) = mpsc::channel(OUTPUT_QUEUE);
        let (closed, mut on_closed) = oneshot::channel::<()>();
        // The writer and the reader are separate tasks so that a write waiting for window space never stops output from draining.
        tokio::spawn(async move {
            while let Some(input) = inputs.recv().await {
                let sent = match input {
                    Input::Data(data) => write.data_bytes(data).await,
                    Input::Resize { cols, rows } => write.window_change(cols, rows, 0, 0).await,
                    Input::Close => break,
                };
                if sent.is_err() {
                    break;
                }
            }
            let _ = write.close().await;
            let _ = closed.send(());
        });
        tokio::spawn(async move {
            loop {
                // russh drops the server's answer to a close we sent, so the reader also stops on our own close.
                let message = tokio::select! {
                    message = read.wait() => message,
                    _ = &mut on_closed => None,
                };
                match message {
                    Some(ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. }) => {
                        if chunks.send(data.to_vec()).await.is_err() {
                            break;
                        }
                    }
                    Some(ChannelMsg::Close) | None => break,
                    Some(_) => {}
                }
            }
        });
        TerminalChannel {
            input: TerminalInput(input),
            output,
        }
    }
}
