/* HexKeyLab Analyzer — generate paste-ready output for samples.ts.
   Takes the shared ALL_RESULTS dict from the harness and emits the
   per-instrument samples array literal (loopPts, validStartsByEnd,
   trimStart) at the precision the engine needs for sample-aligned
   playback. */

export const HKLOutput = (function () {
  function fmt(x, n) { return (+x.toFixed(n)).toString(); }

  function generateOutput(ALL_RESULTS) {
    var output = document.getElementById('output');
    var lines = ['/* PRECOMPUTED loop points — generated ' + new Date().toISOString() + ' */', ''];
    var totalChecked = 0;
    for (var inst in ALL_RESULTS) {
      var rows = ALL_RESULTS[inst].filter(function (r) { return r.chk.checked && r.result; });
      if (rows.length === 0) continue;
      lines.push('    /* ' + inst + ' — ' + rows.length + ' samples */');
      lines.push('    ' + inst + '_samples = [');
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i]; var res = r.result; var s = r.sample;
        /* loopPts at 7 decimals so integer-sample positions round-trip exactly.
           Lower precision loses ~0.5 sample per pt, producing audible sub-sample
           alignment artifacts at runtime. */
        var ptsStr = '[' + res.loopPts.map(function (p) { return fmt(p, 7); }).join(',') + ']';
        var ebsStr = '[' + (res.validStartsByEnd || []).map(function (arr) {
          return '[' + arr.join(',') + ']';
        }).join(',') + ']';
        /* Prefer analyzer-measured fundamental over the labeled one; see
           freqActual in prepareLoop's return. */
        var emitFreq = (typeof res.freqActual === 'number') ? fmt(res.freqActual, 3) : s.freq;
        var line = "        {name:'" + s.name + "',freq:" + emitFreq + ',loopPts:' + ptsStr +
          ',validStartsByEnd:' + ebsStr +
          ',trimStart:' + fmt(res.trimStart, 7) + '}';
        if (i < rows.length - 1) line += ',';
        lines.push(line);
        totalChecked++;
      }
      lines.push('    ],');
      lines.push('');
    }
    output.textContent = lines.join('\n');
    var status = document.getElementById('status');
    status.textContent = 'Generated output for ' + totalChecked + ' selected samples.';
    status.className = 'status ok';
  }

  return { generateOutput: generateOutput, fmt: fmt };
})();
