self.addEventListener('message', event => {
  const message = event.data;
  if (message.type !== 'convert') {
    return;
  }

  const fmfText = convertTrackToFmf(message);
  self.postMessage({ type: 'done', text: fmfText });
});

function convertTrackToFmf({ bpm, notes, mode }) {
  const noteTokens = buildFmfTokens(notes, bpm, mode);
  return [
    'Filetype: Flipper Music Format',
    'Version: 0',
    `BPM: ${bpm}`,
    'Duration: 4',
    'Octave: 4',
    `Notes: ${noteTokens.join(',')}`,
  ].join('\n') + '\n';
}

function buildFmfTokens(notes, bpm, mode = 'highest') {
  if (!notes.length) {
    return ['P'];
  }

  // Sort notes by start time
  const orderedNotes = [...notes].slice().sort((a, b) => a.startSeconds - b.startSeconds || a.noteNumber - b.noteNumber);

  // Build on/off events
  const events = [];
  orderedNotes.forEach((note) => {
    events.push({ time: note.startSeconds, type: 'on', note });
    events.push({ time: note.endSeconds, type: 'off', note });
  });

  // Off events first at same time to allow immediate switching
  events.sort((a, b) => a.time - b.time || (a.type === b.type ? 0 : (a.type === 'off' ? -1 : 1)));

  const active = new Set();
  const segments = []; // { noteNumber, start, end }
  let currentNote = null;
  let currentStart = null;
  let lastTime = events.length ? events[0].time : 0;

  // Post initial progress baseline
  let processedNotes = 0;
  const totalNotes = orderedNotes.length;

  for (let i = 0; i < events.length; ) {
    const t = events[i].time;

    // Process all events at time t
    while (i < events.length && events[i].time === t) {
      const ev = events[i];
      if (ev.type === 'on') {
        active.add(ev.note);
      } else {
        // remove matching note object(s)
        for (const n of Array.from(active)) {
          if (n === ev.note) {
            active.delete(n);
          }
        }
      }
      i += 1;
    }

    // Decide which note should play now
    let nextNote = null;
    if (active.size > 0) {
      const arr = Array.from(active);
      if (mode === 'highest') {
        nextNote = arr.reduce((a, b) => (a.noteNumber > b.noteNumber ? a : b));
      } else if (mode === 'lowest') {
        nextNote = arr.reduce((a, b) => (a.noteNumber < b.noteNumber ? a : b));
      } else {
        // 'both' -> pick earliest-starting active note
        nextNote = arr.reduce((a, b) => (a.startSeconds <= b.startSeconds ? a : b));
      }
    }

    // If there is a gap between lastTime and t and no current note, that's a rest
    if (currentNote === null && nextNote === null) {
      // nothing playing; just advance lastTime
      lastTime = t;
      continue;
    }

    // If currentNote exists and differs from nextNote, or a new same-pitch
    // note starts exactly at this time, close current segment at t
    if (currentNote && (!nextNote || nextNote.noteNumber !== currentNote.noteNumber || (nextNote.startSeconds === t && nextNote.noteNumber === currentNote.noteNumber))) {
      segments.push({ noteNumber: currentNote.noteNumber, start: currentStart, end: t });
      currentNote = null;
      currentStart = null;
    }

    // If no currentNote but nextNote exists, start it at t
    if (!currentNote && nextNote) {
      // If there was a rest between last segment end and t, it will be handled later when serializing
      currentNote = nextNote;
      currentStart = t;
    }

    // Update processedNotes progress when we've advanced past a note's start
    // We'll increment processedNotes for each ordered note whose start <= t
    while (processedNotes < totalNotes && orderedNotes[processedNotes].startSeconds <= t) {
      processedNotes += 1;
      self.postMessage({ type: 'progress', value: processedNotes, total: totalNotes });
    }

    lastTime = t;
  }

  // Close any lingering currentNote at its latest end
  if (currentNote) {
    const end = currentNote.endSeconds;
    segments.push({ noteNumber: currentNote.noteNumber, start: currentStart, end });
  }

  // Serialize segments into FMF tokens, inserting rests where needed
  const tokens = [];
  let cursor = 0;
  segments.sort((a, b) => a.start - b.start);
  segments.forEach((seg) => {
    if (seg.start > cursor + 1e-9) {
      tokens.push(durationToken(seg.start - cursor, bpm));
    }
    tokens.push(formatNoteToken(seg.noteNumber, seg.end - seg.start, bpm));
    cursor = Math.max(cursor, seg.end);
  });

  // If nothing produced, fallback to original behavior
  if (tokens.length === 0) {
    // post progress full
    for (let idx = 0; idx < totalNotes; idx++) {
      self.postMessage({ type: 'progress', value: idx + 1, total: totalNotes });
    }
    return orderedNotes.map(n => formatNoteToken(n.noteNumber, n.endSeconds - n.startSeconds, bpm));
  }

  return tokens;
}

function durationToken(seconds, bpm) {
  const beats = Math.max(0.125, secondsToBeats(seconds, bpm));
  const denominator = clampDuration(Math.round(4 / beats));
  return `${denominator}P`;
}

function formatNoteToken(noteNumber, seconds, bpm) {
  const [noteName, octave] = midiToNoteName(noteNumber);
  const beats = Math.max(0.125, secondsToBeats(seconds, bpm));
  const denominator = clampDuration(Math.round(4 / beats));
  return `${denominator}${noteName}${octave}`;
}

function secondsToBeats(seconds, bpm) {
  return (seconds * bpm) / 60;
}

function clampDuration(value) {
  return Math.min(128, Math.max(1, value || 4));
}

function midiToNoteName(noteNumber) {
  const pitchClasses = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const pitch = pitchClasses[noteNumber % 12];
  const octave = Math.floor(noteNumber / 12) - 1;
  return [pitch, octave];
}