# app/api/routes/voice_stream.py
import asyncio
import struct

# Audio constants -- must match browser playIncomingAudio() and initMicAnalyser()
SAMPLE_RATE  = 48000   # LiveKit native rate; avoids resampler artifacts
NUM_CHANNELS = 1


def float32_to_int16_bytes(float32_data) -> bytes:
    """
    Convert LiveKit AudioFrame float32 buffer to int16 LE PCM.
    LiveKit delivers float32 in [-1.0, 1.0]; browsers expect int16.
    Sending raw float32 bytes interpreted as int16 causes rasping.
    """
    n = len(float32_data) // 4
    samples = struct.unpack_from(f"{n}f", bytes(float32_data))
    return struct.pack(f"{n}h", *(int(max(-1.0, min(1.0, s)) * 32767) for s in samples))
import json
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.services.session_manager import session_manager

router = APIRouter(prefix="/api/voice", tags=["VoiceStream"])
logger = logging.getLogger("voice_stream")


@router.websocket("/stream")
async def voice_stream(websocket: WebSocket):
    """
    WebSocket bridge: browser <-> Voice.AI LiveKit room.

    Uses the LiveKit Python SDK (livekit-rtc) to properly join the room,
    publish mic audio, and subscribe to the agent's audio output.

    Browser protocol:
        -> handshake JSON  { server_url, participant_token, call_id, session_id }
        -> binary frames   PCM-16 mono 16 kHz mic chunks
        -> { type: "ping" }      latency probe
        -> { type: "interrupt" } user barge-in
        <- binary frames   PCM-16 mono 16 kHz agent audio
        <- { type: "pong" }
        <- { type: "state",   state: "listening"|"thinking"|"speaking" }
        <- { type: "message", sender, text }
        <- { type: "latency", latency: ms }
    """
    await websocket.accept()

    room         = None
    call_id      = None
    session_id   = None
    audio_source = None
    stop_event   = asyncio.Event()

    try:
        # -- 1. Handshake ------------------------------------------------------
        raw  = await websocket.receive_text()
        data = json.loads(raw)

        server_url        = data.get("server_url")
        participant_token = data.get("participant_token")
        call_id           = data.get("call_id")
        session_id        = data.get("session_id")
        is_reconnect      = data.get("reconnect", False)

        if not server_url or not participant_token:
            await websocket.send_text(
                json.dumps({"error": "Missing server_url or participant_token"})
            )
            await websocket.close()
            return

        logger.info(
            f"Voice stream {'reconnect' if is_reconnect else 'start'} -- "
            f"call_id={call_id}  session_id={session_id}"
        )

        # -- 2. Join LiveKit room via SDK --------------------------------------
        try:
            from livekit import rtc as lk
        except ImportError:
            logger.error("livekit-rtc not installed. Run: pip install livekit")
            await websocket.send_text(
                json.dumps({"error": "Server missing livekit package"})
            )
            await websocket.close()
            return

        room         = lk.Room()
        audio_source = lk.AudioSource(sample_rate=SAMPLE_RATE, num_channels=1)
        mic_track    = lk.LocalAudioTrack.create_audio_track("mic", audio_source)

        # -- 3. Agent audio -> browser ----------------------------------------
        async def forward_agent_audio(track):
            """
            Read frames from the agent audio track, convert float32->int16,
            and stream raw PCM bytes to the browser.
            LiveKit AudioFrame.data is float32; sending it raw as int16 causes rasping.
            """
            audio_stream = lk.AudioStream(track, sample_rate=SAMPLE_RATE, num_channels=NUM_CHANNELS)
            async for frame_event in audio_stream:
                if stop_event.is_set():
                    break
                frame = frame_event.frame
                try:
                    pcm_bytes = float32_to_int16_bytes(frame.data)
                    await websocket.send_bytes(pcm_bytes)
                except Exception:
                    stop_event.set()
                    break

        @room.on("track_subscribed")
        def on_track_subscribed(track, publication, participant):
            if isinstance(track, lk.RemoteAudioTrack):
                logger.info(f"Subscribed to agent audio track: {track.sid}")
                asyncio.ensure_future(forward_agent_audio(track))

        # Forward agent data-channel messages (state / transcript / latency)
        @room.on("data_received")
        def on_data(data_packet):
            try:
                msg = json.loads(bytes(data_packet.data).decode())
                asyncio.ensure_future(websocket.send_text(json.dumps(msg)))
            except Exception:
                pass

        # Connect and publish mic track
        await room.connect(server_url, participant_token)
        await room.local_participant.publish_track(
            mic_track,
            lk.TrackPublishOptions(source=lk.TrackSource.SOURCE_MICROPHONE),
        )
        logger.info(f"Joined LiveKit room -- call_id={call_id}")

        # -- 4. Browser -> room relay loop ------------------------------------
        while True:
            msg = await websocket.receive()

            if msg["type"] == "websocket.disconnect":
                logger.info("Browser disconnected")
                break

            # PCM binary -> push into audio source for the agent to hear
            if "bytes" in msg and msg["bytes"]:
                frame = lk.AudioFrame(
                    data=msg["bytes"],
                    sample_rate=SAMPLE_RATE,
                    num_channels=NUM_CHANNELS,
                    samples_per_channel=len(msg["bytes"]) // 2,
                )
                await audio_source.capture_frame(frame)

            elif "text" in msg and msg["text"]:
                try:
                    ctrl = json.loads(msg["text"])
                except json.JSONDecodeError:
                    ctrl = {}

                msg_type = ctrl.get("type")

                if msg_type == "ping":
                    await websocket.send_text(json.dumps({"type": "pong"}))

                elif msg_type == "interrupt":
                    logger.info(f"Interrupt -- call_id={call_id}")
                    try:
                        await room.local_participant.publish_data(
                            json.dumps({"type": "interrupt"}).encode(),
                            reliable=True,
                        )
                    except Exception as exc:
                        logger.warning(f"Interrupt publish failed: {exc}")

    except WebSocketDisconnect:
        logger.info(f"WebSocket disconnected -- call_id={call_id}")

    except Exception as exc:
        logger.error(f"Voice stream failure -- call_id={call_id}: {exc}")

    finally:
        stop_event.set()

        if room:
            try:
                await room.disconnect()
            except Exception:
                pass

        if call_id:
            session = session_manager.get_session_by_call_id(call_id)
            if session:
                session_manager.end_session(session["session_id"])

        logger.info(f"Voice stream closed -- call_id={call_id}")