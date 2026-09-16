"""Run with Python + lupa; mocks Resolve and IO, never launches either app."""
import json
import unittest
from pathlib import Path
from lupa import LuaRuntime

SOURCE = (Path(__file__).resolve().parents[1] / 'r2ae.lua').read_text()

class SenderTests(unittest.TestCase):
    def run_sender(self, fps='29.97 DF', start=107892, marks=(120000,120029),
                   srcfps='59.94', interlace='0', reverse=False, audio=True,
                   overrides='', source=SOURCE, drop=None):
        lua = LuaRuntime(unpack_returned_tuples=True)
        lua.globals().FPS = fps
        lua.globals().START = start
        lua.globals().IN, lua.globals().OUT = marks
        lua.globals().SRCFPS = srcfps
        lua.globals().INTERLACE = interlace
        lua.globals().DROP = drop
        lua.globals().REVERSE = reverse
        lua.globals().AUDIO = audio
        lua.execute('''
        output, logs = nil, {}
        print = function(...) logs[#logs+1] = table.concat({...}, " ") end
        os.getenv = function() return "/mock" end
        os.execute = function() error("Must not launch a command in tests") end
        io.open = function(path, mode)
            if path:match("r2ae_receive.jsx$") then return nil end
            return {close=function() return true end,
                    write=function(self, text) output=text; return self end}
        end
        -- Directory creation is stubbed separately; app launch must never run.
        local ts = {timelineFrameRate=FPS,timelineResolutionWidth="3840",
            timelineResolutionHeight="2160",timelineInterlaceProcessing=INTERLACE,
            timelinePixelAspectRatio="Square",timelineDropFrameTimecode=DROP}
        local props = {["File Path"]="/mock/test.mov",["FPS"]=SRCFPS,
            ["Frames"]="1000",["Resolution"]="1920x1080",
            ["Start TC"]="01:00:00;00",["Field Dominance"]="Upper Field First"}
        local mpi = {GetClipProperty=function() return props end}
        local item = {
            GetStart=function() return START+IN-10 end,
            GetEnd=function() return START+OUT+11 end,
            GetDuration=function() return OUT-IN+21 end,
            GetLeftOffset=function() return 100 end,
            GetRightOffset=function() return 800 end,
            GetSourceStartFrame=function() return REVERSE and 199 or 100 end,
            GetSourceEndFrame=function() return REVERSE and 100 or 199 end,
            GetClipEnabled=function() return true end,
            GetMediaPoolItem=function() return mpi end,
            GetName=function() return '日本語 "clip"\\nline\\t' end,
            GetProperty=function() return {FlipX=false,FlipY=false} end
        }
        local timeline = {
            GetSetting=function() return ts end,
            GetStartTimecode=function() return "01:00:00:00" end,
            GetStartFrame=function() return START end,
            GetMarkInOut=function() return {video={['in']=IN,out=OUT},audio={['in']=IN,out=OUT}} end,
            GetTrackCount=function(self, kind) return kind=="video" and 1 or (AUDIO and 1 or 0) end,
            GetItemListInTrack=function() return {item} end,
            GetIsTrackEnabled=function() return true end,
            GetName=function() return "timeline" end
        }
        local project = {
            GetSetting=function() return {timelineFrameRate="24",timelineResolutionWidth="1920",timelineResolutionHeight="1080"} end,
            GetCurrentTimeline=function() return timeline end
        }
        resolve = {GetProjectManager=function() return {GetCurrentProject=function() return project end} end}
        ''')
        modified = source.replace('ensure_dir(BRIDGE_DIR)', '-- test: no directory creation')
        if overrides:
            modified = modified.replace('local TIMELINE_FRAME_RATE_OVERRIDE = nil',
                                        'local TIMELINE_FRAME_RATE_OVERRIDE = '+overrides)
        lua.execute(modified)
        return json.loads(lua.globals().output) if lua.globals().output else None

    def test_df_timeline_and_long_relative_marks(self):
        d=self.run_sender()
        self.assertAlmostEqual(d['fps'],30000/1001)
        self.assertTrue(d['drop_frame'])
        self.assertEqual((d['width'],d['height']),(3840,2160))
        self.assertEqual(d['display_start_frame'],227892)
        self.assertEqual(d['duration'],30)
        self.assertEqual(d['clips'][-1]['source_in'],120)
        self.assertEqual(d['clips'][-1]['speed'],1)
        self.assertEqual(len(d['clips']),1)
        self.assertEqual(d['clips'][0]['kind'],'video')
        self.assertFalse(d['clips'][-1]['mute_audio'])
        self.assertIn('\n', d['clips'][0]['name'])

    def merge_audio(self, clips, mode='auto'):
        lua=LuaRuntime(unpack_returned_tuples=True)
        lua.globals().AUDIO_MODE=mode
        lua.globals().fps=24
        start=SOURCE.index('local function resolve_audio_duplicates(list)')
        end=SOURCE.index('local dedupedList',start)
        fn=lua.execute(SOURCE[start:end]+'\nreturn resolve_audio_duplicates')
        return fn(lua.table_from(clips,recursive=True))

    def test_audio_merge_preserves_mismatched_edits(self):
        base=dict(path='/same.mov',start=100,duration=48,source_in=60,speed=1,src_fps=24)
        for key,value in [('start',101),('duration',47),('source_in',61),('speed',2),('src_fps',25)]:
            with self.subTest(key=key):
                audio=dict(base,kind='audio');audio[key]=value
                kept,count=self.merge_audio([audio,dict(base,kind='video')])
                self.assertEqual(count,0)
                self.assertEqual(len(kept),2)
                self.assertTrue(kept[2]['mute_audio'])

    def test_one_audio_enables_only_one_video_instance(self):
        base=dict(path='/same.mov',start=100,duration=48,source_in=60,speed=1,src_fps=24)
        kept,count=self.merge_audio([dict(base,kind='audio'),dict(base,kind='video'),dict(base,kind='video')])
        self.assertEqual(count,1)
        self.assertEqual(sum(not kept[i]['mute_audio'] for i in range(1,len(kept)+1)),1)

    def test_ambiguous_duplicate_audio_is_not_silently_deleted(self):
        base=dict(path='/same.mov',start=100,duration=48,source_in=60,speed=1,src_fps=24)
        kept,count=self.merge_audio([dict(base,kind='audio'),dict(base,kind='audio'),dict(base,kind='video')])
        self.assertEqual(count,0)
        self.assertEqual(len(kept),3)
        self.assertTrue(kept[3]['mute_audio'])

    def test_separate_mode_remains_available(self):
        base=dict(path='/same.mov',start=100,duration=48,source_in=60,speed=1,src_fps=24)
        kept,count=self.merge_audio([dict(base,kind='audio'),dict(base,kind='video')],mode='separate')
        self.assertEqual(count,0)
        self.assertTrue(kept[2]['mute_audio'])

    def test_reverse_at_100_percent_keeps_sign(self):
        d=self.run_sender(reverse=True)
        self.assertEqual(d['clips'][-1]['speed'],-1)
        self.assertEqual(d['clips'][-1]['source_in'],179)

    def test_no_audio_does_not_restore_embedded_sound(self):
        d=self.run_sender(audio=False)
        self.assertTrue(d['clips'][0]['mute_audio'])

    def test_ndf_does_not_become_df_because_of_source_tc(self):
        d=self.run_sender(fps='29.97')
        self.assertFalse(d['drop_frame'])

    def test_interlace_converts_field_ticks_without_changing_seconds(self):
        d=self.run_sender(fps='59.94',interlace='1',start=215784,marks=(0,157),audio=False,drop='1')
        self.assertAlmostEqual(d['fps'],30000/1001)
        self.assertEqual(d['duration'],79)
        self.assertEqual(d['display_start_frame'],107892)
        self.assertEqual(d['resolve_ticks_per_frame'],2)
        self.assertAlmostEqual(d['duration']/d['fps'],158/(60000/1001))
        self.assertEqual(d['clips'][0]['duration'],79)
        self.assertTrue(d['drop_frame'])

    def test_progressive_5994_is_not_halved(self):
        d=self.run_sender(fps='59.94 DF',interlace='0',marks=(0,157))
        self.assertAlmostEqual(d['fps'],60000/1001)
        self.assertEqual(d['duration'],158)
        self.assertTrue(d['drop_frame'])

    def test_interlace_pal_and_half_frame_marks(self):
        d=self.run_sender(fps='50',interlace='1',start=180000,marks=(1,50))
        self.assertEqual(d['fps'],25)
        self.assertEqual(d['duration'],25)
        self.assertIsNone(d['display_start_frame'])
        self.assertAlmostEqual(d['display_start_time'],180001/50)

    def test_audio_only_marks_fallback(self):
        source=SOURCE.replace('local v, au = mio.video, mio.audio','local v, au = {}, mio.audio')
        self.assertEqual(self.run_sender(source=source)['duration'],30)

    def test_partial_marks_rejected(self):
        self.assertIsNone(self.run_sender(marks=(-1,29)))

    def test_invalid_fps_does_not_silently_use_24(self):
        for raw in ['bogus', '0', '30000/0', '29.97 nonsense']:
            with self.subTest(raw=raw):
                self.assertIsNone(self.run_sender(fps=raw))

    def test_small_real_retime_is_not_rounded_by_two_percent(self):
        source=SOURCE.replace('local dur = item:GetDuration()', 'local dur = 1000')
        source=source.replace('local used = usedA or usedB', 'local used = 2020')
        d=self.run_sender(source=source)
        self.assertAlmostEqual(d['clips'][-1]['speed'],1.01)

    def test_fractional_rates(self):
        for raw,expected in [('23.98',24000/1001),('23.976',24000/1001),
                             ('30000/1001',30000/1001),('24',24),('30',30),('60',60)]:
            with self.subTest(raw=raw):
                self.assertAlmostEqual(self.run_sender(fps=raw)['fps'],expected)

if __name__=='__main__': unittest.main()
