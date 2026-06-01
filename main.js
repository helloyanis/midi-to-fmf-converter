const midiFileInput = document.getElementById('midiFile');
const trackSelect = document.getElementById('trackSelect');
const playPauseButton = document.getElementById('playPauseButton');
const stopButton = document.getElementById('stopButton');
const seekSlider = document.getElementById('seekSlider');
const timeLabel = document.getElementById('timeLabel');
const convertButton = document.getElementById('convertButton');
const progressBar = document.getElementById('progressBar');
const statusLabel = document.getElementById('status');
const polyModeSelect = document.getElementById('polyMode');

const audioContext = new (window.AudioContext || window.webkitAudioContext)();
const worker = new Worker('worker.js');

let currentMidi = null;
let selectedTrackIndex = null;
let playbackState = null;
let rafId = 0;
let activeSources = [];
let currentObjectUrl = null;
let currentFileName = 'track.fmf';

worker.addEventListener('message', event => {
  const message = event.data;
  if (message.type === 'progress') {
    progressBar.hidden = false;
    progressBar.max = message.total;
    progressBar.value = message.value;
    return;
  }

  if (message.type === 'done') {
    progressBar.hidden = true;
    statusLabel.textContent = 'FMF file ready.';
    if (currentObjectUrl) {
      URL.revokeObjectURL(currentObjectUrl);
    }

    const blob = new Blob([message.text], { type: 'text/plain;charset=utf-8' });
    currentObjectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = currentObjectUrl;
    anchor.download = currentFileName;
    anchor.click();
  }
});

midiFileInput.addEventListener('change', async () => {
  const file = midiFileInput.files && midiFileInput.files[0];
  if (!file) {
    return;
  }

  stopPlayback();
  statusLabel.textContent = 'Reading MIDI file...';
  progressBar.hidden = false;
  progressBar.removeAttribute('value');

  const arrayBuffer = await file.arrayBuffer();
  currentMidi = parseMidi(arrayBuffer);
  currentFileName = file.name.replace(/\.(mid|midi)$/i, '') + '.fmf';
  selectedTrackIndex = null;
  renderTrackOptions(currentMidi);
  statusLabel.textContent = 'Choose a track to preview or convert.';
  progressBar.hidden = true;
});

trackSelect.addEventListener('change', () => {
  const value = trackSelect.value;
  selectedTrackIndex = value === '' ? null : Number(value);
  refreshControls();
});

playPauseButton.addEventListener('click', async () => {
  if (!currentMidi || selectedTrackIndex === null) {
    return;
  }

  await audioContext.resume();

  if (playbackState && !playbackState.paused) {
    pausePlayback();
    return;
  }

  startPlayback(selectedTrackIndex, playbackState ? playbackState.position : Number(seekSlider.value));
});

stopButton.addEventListener('click', () => {
  stopPlayback();
});

seekSlider.addEventListener('input', () => {
  const position = Number(seekSlider.value);
  updateTimeLabel(position, playbackState ? playbackState.duration : Number(seekSlider.max));
  if (playbackState && !playbackState.paused) {
    startPlayback(selectedTrackIndex, position);
  } else if (playbackState) {
    playbackState.position = position;
  }
});

convertButton.addEventListener('click', () => {
  if (!currentMidi || selectedTrackIndex === null) {
    return;
  }

  const track = currentMidi.tracks[selectedTrackIndex];
  const noteEvents = track.events.filter(event => event.type === 'note');
  progressBar.hidden = false;
  progressBar.max = Math.max(1, noteEvents.length || 1);
  progressBar.value = 0;
  statusLabel.textContent = 'Converting to FMF...';
  worker.postMessage({
    type: 'convert',
    bpm: currentMidi.tempoBpm,
    notes: noteEvents,
    mode: polyModeSelect ? polyModeSelect.value : 'highest',
  });
});

function renderTrackOptions(midi) {
  trackSelect.innerHTML = '';
  const availableTracks = midi.tracks
    .map((track, index) => ({ track, index }))
    .filter(item => item.track.events.some(event => event.type === 'note'));

  if (availableTracks.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No tracks with notes found';
    trackSelect.append(option);
    trackSelect.disabled = true;
    refreshControls();
    return;
  }

  trackSelect.disabled = false;
  for (const item of availableTracks) {
    const option = document.createElement('option');
    option.value = String(item.index);
    option.textContent = item.track.name ? `${item.index + 1}: ${item.track.name}` : `Track ${item.index + 1}`;
    trackSelect.append(option);
  }

  trackSelect.value = availableTracks[0].index;
  selectedTrackIndex = availableTracks[0].index;
  refreshControls();
}

function refreshControls() {
  const enabled = currentMidi && selectedTrackIndex !== null;
  playPauseButton.disabled = !enabled;
  stopButton.disabled = !enabled;
  convertButton.disabled = !enabled;
  seekSlider.disabled = !enabled;
}

function startPlayback(trackIndex, seekToSeconds = 0) {
  stopPlayback();

  const track = currentMidi.tracks[trackIndex];
  const duration = track.totalDurationSeconds || 0;
  const playbackPosition = Math.min(Math.max(seekToSeconds, 0), duration);
  const startTime = audioContext.currentTime + 0.05;
  const scheduled = [];

  for (const event of track.events) {
    if (event.type !== 'note') {
      continue;
    }

    const noteStart = event.startSeconds;
    const noteEnd = event.endSeconds;
    if (noteEnd <= playbackPosition) {
      continue;
    }

    const effectiveStart = Math.max(noteStart, playbackPosition);
    const relativeStart = effectiveStart - playbackPosition;
    const remaining = noteEnd - effectiveStart;
    if (remaining <= 0) {
      continue;
    }

    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();
    oscillator.type = 'square';
    oscillator.frequency.value = midiNoteToFrequency(event.noteNumber);
    gainNode.gain.value = 0.08;
    oscillator.connect(gainNode).connect(audioContext.destination);
    oscillator.start(startTime + relativeStart);
    oscillator.stop(startTime + relativeStart + remaining);
    scheduled.push(oscillator);
  }

  playbackState = {
    trackIndex,
    position: playbackPosition,
    startedAt: performance.now(),
    startTime,
    paused: false,
    duration,
  };

  activeSources = scheduled;
  seekSlider.max = String(duration);
  seekSlider.value = String(playbackPosition);
  playPauseButton.textContent = 'Pause';
  updateTimeLabel(playbackPosition, duration);
  tickPlayback();
}

function pausePlayback() {
  if (!playbackState) {
    return;
  }

  const elapsed = Math.max(0, audioContext.currentTime - playbackState.startTime);
  playbackState.position = Math.min(playbackState.duration, playbackState.position + elapsed);
  playbackState.paused = true;
  stopScheduledSources();
  playPauseButton.textContent = 'Play';
  seekSlider.value = String(playbackState.position);
  updateTimeLabel(playbackState.position, playbackState.duration);
}

function stopPlayback() {
  stopScheduledSources();
  cancelAnimationFrame(rafId);
  rafId = 0;
  if (playbackState) {
    playbackState.position = 0;
    playbackState.paused = true;
    seekSlider.value = '0';
    updateTimeLabel(0, playbackState.duration);
  }
  playPauseButton.textContent = 'Play';
}

function stopScheduledSources() {
  for (const source of activeSources) {
    try {
      source.stop();
    } catch {
      // Ignore nodes that have already stopped.
    }
  }
  activeSources = [];
}

function tickPlayback() {
  if (!playbackState || playbackState.paused) {
    return;
  }

  const elapsed = audioContext.currentTime - playbackState.startTime;
  const position = Math.min(playbackState.duration, playbackState.position + elapsed);
  seekSlider.value = String(position);
  updateTimeLabel(position, playbackState.duration);

  if (position >= playbackState.duration) {
    stopPlayback();
    return;
  }

  rafId = requestAnimationFrame(() => tickPlayback());
}

function updateTimeLabel(positionSeconds, durationSeconds) {
  timeLabel.textContent = `${formatTime(positionSeconds)} / ${formatTime(durationSeconds)}`;
}

function formatTime(seconds) {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const wholeSeconds = Math.floor(safeSeconds);
  const minutes = Math.floor(wholeSeconds / 60);
  const remaining = String(wholeSeconds % 60).padStart(2, '0');
  return `${minutes}:${remaining}`;
}

function midiNoteToFrequency(noteNumber) {
  return 440 * Math.pow(2, (noteNumber - 69) / 12);
}

function parseMidi(arrayBuffer) {
  const reader = new MidiReader(arrayBuffer);
  const headerChunk = reader.readChunk();
  if (headerChunk.id !== 'MThd') {
    throw new Error('Invalid MIDI file.');
  }

  const headerReader = new MidiReader(headerChunk.data);
  const format = headerReader.readUint16();
  const trackCount = headerReader.readUint16();
  const division = headerReader.readUint16();
  const tracks = [];
  const tempoEvents = [{ tick: 0, tempoMicroseconds: 500000 }];

  for (let trackIndex = 0; trackIndex < trackCount; trackIndex += 1) {
    const chunk = reader.readChunk();
    if (chunk.id !== 'MTrk') {
      continue;
    }

    const trackReader = new MidiReader(chunk.data);
    const track = parseTrack(trackReader);
    tempoEvents.push(...track.tempoEvents);
    tracks.push(track);
  }

  const tempoConverter = createTickToSecondsConverter(tempoEvents, division);
  for (const track of tracks) {
    for (const event of track.rawNotes) {
      event.startSeconds = tempoConverter(event.startTick);
      event.endSeconds = tempoConverter(event.endTick);
    }
    track.events = track.rawNotes.map(event => ({ type: 'note', ...event }));
    track.totalDurationSeconds = tempoConverter(track.totalTick);
  }

  const tempoBpm = Math.round(60000000 / (tempoEvents[0]?.tempoMicroseconds || 500000));
  return { format, division, tempoBpm, tracks };
}

function parseTrack(reader) {
  const rawNotes = [];
  const tempoEvents = [];
  const activeNotes = new Map();
  let tick = 0;
  let runningStatus = null;
  let trackName = '';

  while (!reader.eof()) {
    const delta = reader.readVarUint();
    tick += delta;

    let status = reader.readUint8();
    if (status < 0x80) {
      if (runningStatus === null) {
        throw new Error('Malformed MIDI data.');
      }
      reader.unreadUint8(status);
      status = runningStatus;
    } else {
      runningStatus = status;
    }

    if (status === 0xff) {
      const metaType = reader.readUint8();
      const length = reader.readVarUint();
      const data = reader.readBytes(length);
      if (metaType === 0x03) {
        trackName = bytesToText(data);
      } else if (metaType === 0x51 && length === 3) {
        tempoEvents.push({ tick, tempoMicroseconds: (data[0] << 16) | (data[1] << 8) | data[2] });
      } else if (metaType === 0x2f) {
        break;
      }
      continue;
    }

    if (status === 0xf0 || status === 0xf7) {
      const length = reader.readVarUint();
      reader.skip(length);
      continue;
    }

    const eventType = status & 0xf0;
    const channel = status & 0x0f;
    const firstData = reader.readUint8();
    const secondData = eventType === 0xc0 || eventType === 0xd0 ? null : reader.readUint8();

    if (eventType === 0x90 && secondData > 0) {
      activeNotes.set(`${channel}:${firstData}`, { startTick: tick, noteNumber: firstData });
      continue;
    }

    if (eventType === 0x80 || (eventType === 0x90 && secondData === 0)) {
      const noteKey = `${channel}:${firstData}`;
      const noteStart = activeNotes.get(noteKey);
      if (noteStart) {
        rawNotes.push({
          startTick: noteStart.startTick,
          endTick: tick,
          noteNumber: noteStart.noteNumber,
        });
        activeNotes.delete(noteKey);
      }
      continue;
    }
  }

  return {
    name: trackName,
    rawNotes: rawNotes.sort((a, b) => a.startTick - b.startTick || a.noteNumber - b.noteNumber),
    tempoEvents,
    totalTick: rawNotes.reduce((max, event) => Math.max(max, event.endTick), 0),
  };
}

function createTickToSecondsConverter(tempoEvents, division) {
  const sortedTempoEvents = [...tempoEvents].sort((a, b) => a.tick - b.tick || a.tempoMicroseconds - b.tempoMicroseconds);
  const normalized = [];
  let lastTick = 0;
  let accumulatedSeconds = 0;
  let tempoMicroseconds = sortedTempoEvents[0]?.tempoMicroseconds || 500000;

  normalized.push({ tick: 0, seconds: 0, tempoMicroseconds });

  for (let index = 1; index < sortedTempoEvents.length; index += 1) {
    const event = sortedTempoEvents[index];
    if (event.tick < lastTick) {
      continue;
    }

    accumulatedSeconds += ticksToSeconds(event.tick - lastTick, tempoMicroseconds, division);
    normalized.push({ tick: event.tick, seconds: accumulatedSeconds, tempoMicroseconds: event.tempoMicroseconds });
    lastTick = event.tick;
    tempoMicroseconds = event.tempoMicroseconds;
  }

  return tick => {
    let segment = normalized[0];
    for (let index = normalized.length - 1; index >= 0; index -= 1) {
      if (tick >= normalized[index].tick) {
        segment = normalized[index];
        break;
      }
    }

    return segment.seconds + ticksToSeconds(tick - segment.tick, segment.tempoMicroseconds, division);
  };
}

function ticksToSeconds(ticks, tempoMicroseconds, division) {
  return (ticks * tempoMicroseconds) / 1000000 / division;
}

function bytesToText(bytes) {
  return new TextDecoder().decode(bytes);
}

class MidiReader {
  constructor(buffer) {
    this.view = new DataView(buffer instanceof ArrayBuffer ? buffer : buffer.buffer, buffer.byteOffset || 0, buffer.byteLength || buffer.byteLength);
    this.offset = 0;
  }

  eof() {
    return this.offset >= this.view.byteLength;
  }

  readUint8() {
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }

  unreadUint8() {
    this.offset = Math.max(0, this.offset - 1);
  }

  readUint16() {
    const value = this.view.getUint16(this.offset, false);
    this.offset += 2;
    return value;
  }

  readUint32() {
    const value = this.view.getUint32(this.offset, false);
    this.offset += 4;
    return value;
  }

  readVarUint() {
    let value = 0;
    while (true) {
      const byte = this.readUint8();
      value = (value << 7) | (byte & 0x7f);
      if ((byte & 0x80) === 0) {
        return value;
      }
    }
  }

  readBytes(length) {
    const bytes = new Uint8Array(this.view.buffer, this.view.byteOffset + this.offset, length);
    this.offset += length;
    return new Uint8Array(bytes);
  }

  skip(length) {
    this.offset += length;
  }

  readChunk() {
    const id = String.fromCharCode(this.readUint8(), this.readUint8(), this.readUint8(), this.readUint8());
    const length = this.readUint32();
    const data = this.readBytes(length).buffer;
    return { id, data };
  }
}
