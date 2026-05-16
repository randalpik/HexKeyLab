-- Spike S2: per-notehead color via FCNoteheadMod.
-- Select one or more notes (or a region) before running.
-- Success: every notehead in the selection turns magenta (#FF0099).
--
-- FCNoteheadMod's color setter is not enumerated in the public PDK doc I
-- could fetch — so this script tries the three most likely API shapes. The
-- one that compiles is the answer. Note which line succeeded for the
-- spike report.

local TARGET_R, TARGET_G, TARGET_B = 0xFF, 0x00, 0x99
local attempt_log = {}

local function try_set(name, fn)
  local ok, err = pcall(fn)
  table.insert(attempt_log, name .. ": " .. (ok and "OK" or ("ERR " .. tostring(err))))
  return ok
end

local region = finenv.Region()
if region:IsEmpty() then
  finenv.UI():AlertInfo(
    "No selection. Select one or more notes before running.",
    "HKL spike S2")
  return
end

local touched = 0

for entry in eachentry(region) do
  if entry:IsNote() then
    for note in each(entry) do
      local mod = finale.FCNoteheadMod()
      mod:SetNoteEntry(entry)
      -- Some loaders need LoadAt first to read existing state.
      pcall(function() mod:LoadAt(note) end)

      local ok = false
      ok = ok or try_set("mod:SetCustomColor(r,g,b)", function()
        mod:SetCustomColor(TARGET_R, TARGET_G, TARGET_B)
      end)
      ok = ok or try_set("mod:SetColor(r,g,b)", function()
        mod:SetColor(TARGET_R, TARGET_G, TARGET_B)
      end)
      ok = ok or try_set("mod.CustomColor (FCColor)", function()
        local c = finale.FCColor()
        c:SetRGB(TARGET_R, TARGET_G, TARGET_B)
        mod.CustomColor = c
      end)
      ok = ok or try_set("mod:SetUseCustomColor(true) + mod.Red/.Green/.Blue", function()
        mod:SetUseCustomColor(true)
        mod.Red = TARGET_R; mod.Green = TARGET_G; mod.Blue = TARGET_B
      end)

      mod:SaveAt(note)
      if ok then touched = touched + 1 end
    end
  end
end

local report = "Notes touched: " .. tostring(touched) .. "\n\nAttempts (last note):\n"
for _, line in ipairs(attempt_log) do
  report = report .. "  " .. line .. "\n"
end
finenv.UI():AlertInfo(report, "HKL spike S2")
