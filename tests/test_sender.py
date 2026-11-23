"""Run with Python + lupa; mocks Resolve and IO, never launches either app."""
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from lupa import LuaRuntime

SOURCE = (Path(__file__).resolve().parents[1] / 'r2ae.lua').read_text()

class SenderTests(unittest.TestCase):
    def run_sender(self, fps='29.97 DF', start=107892, span=(120000,120050),
                   srcfps='59.94', interlace='0', reverse=False, audio=True,
                   overrides='', source=SOURCE, drop=None, selection=None, fcpxml=None,
                   camera_fps=None, color_science=None, clip_idt=None, project_idt=None,
                   speed_percentage=None, source_in_time=None, drt_pool=None):
        lua = LuaRuntime(unpack_returned_tuples=True)
        lua.globals().FPS = fps
        lua.globals().START = start
        lua.globals().FIRST, lua.globals().LAST = span
        lua.globals().SRCFPS = srcfps
        lua.globals().SPEED_PERCENTAGE = speed_percentage
        lua.globals().SOURCE_IN_TIME = source_in_time
        lua.globals().CAMERAFPS = camera_fps
        lua.globals().COLOR_SCIENCE = color_science
        lua.globals().CLIP_IDT = clip_idt
        lua.globals().PROJECT_IDT = project_idt
        lua.globals().INTERLACE = interlace
        lua.globals().DROP = drop
        lua.globals().REVERSE = reverse
        lua.globals().AUDIO = audio
        lua.globals().SELECTION = selection
        lua.globals().DRT_POOL = drt_pool
        if fcpxml is not None:
            xsltproc = shutil.which('xsltproc')
            if not xsltproc:
                self.skipTest('macOS FCPXML extraction uses xsltproc')
            def extract_rows(stylesheet):
                with tempfile.TemporaryDirectory() as directory:
                    style_path = Path(directory) / 'test.xsl'
                    style_path.write_text(stylesheet)
                    return subprocess.check_output([xsltproc, '--nonet', str(style_path), '-'],
                                                   input=fcpxml, text=True)
            lua.globals().extract_rows = extract_rows
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
            timelinePixelAspectRatio="Square",timelineDropFrameTimecode=DROP,
            timelineInputResMismatchBehavior="scaleToCrop"}
        local props = {["File Path"]="/mock/test.mov",["FPS"]=SRCFPS,
            ["Camera FPS"]=CAMERAFPS,
            ["IDT"]=CLIP_IDT,
            ["Frames"]="1000",["Resolution"]="1920x1080",
            ["Start TC"]="01:00:00;00",["Field Dominance"]="Upper Field First"}
        local mpi = {GetClipProperty=function() return props end}
        if DRT_POOL then mpi.GetMediaId = function() return '12345678-1234-1234-1234-123456789abc' end end
        local base = {
            GetLeftOffset=function() return 100 end,
            GetRightOffset=function() return 800 end,
            GetSourceStartFrame=function() return REVERSE and 199 or 100 end,
            GetSourceEndFrame=function() return REVERSE and 100 or 199 end,
            GetSourceStartTime=function() return SOURCE_IN_TIME end,
            GetSpeed=function() return SPEED_PERCENTAGE and {Percentage=SPEED_PERCENTAGE} end,
            GetClipEnabled=function() return true end,
            GetMediaPoolItem=function() return mpi end,
            GetName=function() return '日本語 "clip"\\nline\\t' end,
            GetProperty=function() return {FlipX=false,FlipY=false} end
        }
        local function clip(kind, track, first, last, opts)
            opts = opts or {}
            return setmetatable({
                GetName=opts.name and function() return opts.name end or nil,
                GetStart=function() return START + first end,
                GetEnd=function() return START + last end,
                GetDuration=function() return last - first end,
                GetTrackTypeAndIndex=function() return {kind, track} end,
                GetClipEnabled=function() return opts.enabled ~= false end,
                GetMediaPoolItem=opts.path and function()
                    return {GetClipProperty=function() return {["File Path"]=opts.path} end}
                end or nil,
            }, {__index=base})
        end
        local selected = {clip('video', 1, FIRST, LAST)}
        if AUDIO then table.insert(selected, clip('audio', 1, FIRST, LAST)) end
        local selections = {
            multi={clip('video', 2, 40, 50, {name='video 2'}),
                   clip('audio', 1, 10, 30, {name='audio 1'}),
                   clip('video', 1, 10, 30, {name='video 1'}),
                   clip('audio', 2, 35, 40, {name='audio 2'}),
                   clip('video', 1, 0, 100, {enabled=false}),
                   clip('video', 3, 0, 100)},
            audio={clip('audio', 1, 10, 30, {path='/mock/standalone.wav'})},
            empty={},
        }
        local timeline = {
            GetSetting=function() return ts end,
            GetStartTimecode=function() return "01:00:00:00" end,
            GetStartFrame=function() return START end,
            GetMarkInOut=function() error('unexpected IN/OUT lookup') end,
            GetItemListInTrack=function() error('unexpected track scan') end,
            GetTrackCount=function() return 3 end,
            GetIsTrackEnabled=function(self, kind, index) return index < 3 end,
            GetName=function() return "timeline" end,
        }
        if SELECTION ~= 'unavailable' then
            timeline.GetSelectedClips=function()
                local items = SELECTION and selections[SELECTION] or selected
                items.n = #items -- Resolve's Lua list also carries metadata.
                return items
            end
        end
        local project = {
            GetSetting=function() return {timelineFrameRate="24",timelineResolutionWidth="1920",
                timelineResolutionHeight="1080",timelineInputResMismatchBehavior="scaleToFit",
                colorScienceMode=COLOR_SCIENCE, acesVersion="aces_2.0", colorAcesIDT=PROJECT_IDT,
                colorAcesODT="Rec.709 - 100 nits"} end,
            GetCurrentTimeline=function() return timeline end
        }
        resolve = {GetProjectManager=function() return {GetCurrentProject=function() return project end} end}
        if extract_rows then
            resolve.EXPORT_FCPXML_1_9 = 1
            timeline.Export = function() return true end
            local style
            local open = io.open
            os.tmpname = function() return '/mock/FCPXML-test' end
            os.remove = function() end
            io.open = function(path, mode)
                if path ~= '/mock/FCPXML-test' then return open(path, mode) end
                return {write=function(self, text) style=text; return self end,
                        close=function() return true end}
            end
            io.popen = function()
                return {read=function() return extract_rows(style) end,
                        close=function() return true end}
            end
        end
        if DRT_POOL then
            resolve.EXPORT_DRT = 2
            timeline.Export = function(self, path, format)
                assert(path == '/mock/orientation.drt' and format == 2)
                return true
            end
            os.tmpname = function() return '/mock/orientation' end
            os.remove = function() end
            io.popen = function(command)
                assert(command:find('/usr/bin/unzip -p', 1, true))
                return {read=function() return DRT_POOL end, close=function() return true end}
            end
        end
        ''')
        modified = source.replace('ensure_dir(BRIDGE_DIR)', '-- test: no directory creation')
        if overrides:
            modified = modified.replace('local TIMELINE_FRAME_RATE_OVERRIDE = nil',
                                        'local TIMELINE_FRAME_RATE_OVERRIDE = '+overrides)
        lua.execute(modified)
        return json.loads(lua.globals().output) if lua.globals().output else None

    def test_selection_preserves_gaps_track_order_and_source_trim(self):
        d = self.run_sender(selection='multi')
        self.assertEqual(d['display_start_frame'], 107902)
        self.assertEqual(d['duration'], 40)
        self.assertEqual([(c['name'], c['offset'], c['duration']) for c in d['clips']],
                         [('audio 2', 25, 5), ('video 1', 0, 20), ('video 2', 30, 10)])
        self.assertEqual(d['clips'][1]['source_in'], 100)
        self.assertFalse(d['clips'][1]['mute_audio'])
        self.assertTrue(d['clips'][2]['mute_audio'])

    def test_camera_fps_and_explicit_source_rotation(self):
        source = SOURCE.replace('-- ["/path/to/clip.mov"] = 90,', '["/mock/test.mov"] = -90,')
        d = self.run_sender(srcfps='23.976', camera_fps='23.98', source=source)
        self.assertAlmostEqual(d['clips'][0]['camera_fps'], 24000 / 1001)
        self.assertEqual(d['clips'][0]['source_rotation'], -90)
        self.assertNotIn('source_rotation', self.run_sender()['clips'][0])

    def test_drt_orientation_uses_media_id_and_subtracts_the_embedded_angle(self):
        def media(id, radiometry):
            return (f'<Sm2MpVideoClip DbId="db-id"><UniqueMediaPoolItemId>{id}</UniqueMediaPoolItemId>'
                    f'<Video><BtVideoInfo DbId="video-info"><Radiometry>{radiometry}</Radiometry>'
                    '</BtVideoInfo></Video></Sm2MpVideoClip>')

        header = '<!--DbAppVer="21.2.0.0006" DbPrjVer="17"-->'
        selected_id = '12345678-1234-1234-1234-123456789abc'
        for radiometry, expected in [
            ('80087810028801329801b401d80100', 90),
            ('80087810028801329801b301d80100', -90),
            ('80087810028801329801e802d80100', 180),
            ('8008781002489803700278c80180018001880132980100d801b401', -90),
            ('8008781002489803700278c801800180018801329801b401d801b401', None),
            ('80087810028801329801b401d801', None),
        ]:
            with self.subTest(radiometry=radiometry):
                drt = header + media('abc-a', '9801e802d80100') + media(selected_id, radiometry)
                clip = self.run_sender(drt_pool=drt)['clips'][0]
                self.assertEqual(clip.get('source_rotation'), expected)

        drt = header + media(selected_id, '9801b401d80100')
        manual_zero = SOURCE.replace('-- ["/path/to/clip.mov"] = 90,', '["/mock/test.mov"] = 0,')
        self.assertNotIn('source_rotation', self.run_sender(drt_pool=drt, source=manual_zero)['clips'][0])
        conflicting = drt + media(selected_id, '9801e802d80100')
        self.assertNotIn('source_rotation', self.run_sender(drt_pool=conflicting)['clips'][0])
        unknown = drt.replace('21.2.0.0006', '22.0.0.0006')
        self.assertNotIn('source_rotation', self.run_sender(drt_pool=unknown)['clips'][0])

    def test_aces_sends_clip_idt_or_the_project_default_and_records_odt(self):
        params = dict(color_science='acescct', project_idt='ARRI LogC4 - CSC')
        with_override = self.run_sender(**params, clip_idt='Sony SLog3 SGamut3Cine - CSC')
        self.assertEqual(with_override['aces'], {
            'mode': 'acescct', 'version': 'aces_2.0', 'odt': 'Rec.709 - 100 nits'
        })
        self.assertEqual(with_override['clips'][0]['src_idt'], 'Sony SLog3 SGamut3Cine - CSC')
        inherited = self.run_sender(**params, clip_idt='Use Project Setting')
        self.assertEqual(inherited['clips'][0]['src_idt'], 'ARRI LogC4 - CSC')
        rcm = self.run_sender(color_science='davinciYRGBColorManagedv2', clip_idt='ARRI LogC4 - CSC')
        self.assertNotIn('aces', rcm)
        self.assertNotIn('src_idt', rcm['clips'][0])

    def test_selection_audio_only(self):
        d = self.run_sender(selection='audio')
        self.assertEqual([c['kind'] for c in d['clips']], ['audio'])
        self.assertEqual(d['duration'], 20)
        self.assertEqual(d['clips'][0]['path'], '/mock/standalone.wav')

    def test_fcpxml_keys_follow_the_selected_nested_clip_and_its_source_trim(self):
        xml = '''<fcpxml><resources><asset id="r1" hasVideo="1">
          <media-rep kind="original-media" src="file:///mock/test%2Emov"/>
        </asset></resources><library><event><project><sequence tcStart="3600s"><spine>
          <asset-clip ref="r1" start="1s" offset="3601s" duration="2s">
            <asset-clip ref="r1" lane="1" start="2s" offset="3/2s" duration="1s">
              <adjust-transform><param name="position"><keyframeAnimation>
                <keyframe time="3/2s" value="0 0"/><keyframe time="5/2s" value="5 2.5"/>
              </keyframeAnimation></param><param name="rotation"><keyframeAnimation>
                <keyframe time="5/2s" value="10"/>
              </keyframeAnimation></param></adjust-transform>
              <adjust-blend><param name="amount"><keyframeAnimation>
                <keyframe time="2s" value="0.75"/>
              </keyframeAnimation></param></adjust-blend>
            </asset-clip>
            <asset-clip ref="r1" lane="-1" srcEnable="audio" start="2s" offset="3/2s" duration="1s"/>
          </asset-clip>
        </spine></sequence></project></event></library></fcpxml>'''
        d = self.run_sender(fps='24', start=86400, span=(36,60), audio=False, fcpxml=xml)
        self.assertEqual(len(d['clips']), 1)
        self.assertEqual(d['clips'][0]['transform_keys'], {
            'position': [[-.5, 0, 0], [.5, 108, 54]],
            'rotation': [[.5, -10]], 'amount': [[0, 75]],
        })
        duplicate = xml.replace('lane="-1" srcEnable="audio"', 'lane="2"')
        d = self.run_sender(fps='24', start=86400, span=(36,60), audio=False, fcpxml=duplicate)
        self.assertNotIn('transform_keys', d['clips'][0])
        self.assertTrue(any('重なっている' in message for message in d['warnings']))

    def test_empty_or_unavailable_selection_never_exports_in_out(self):
        for selection in ('empty', 'unavailable'):
            with self.subTest(selection=selection):
                self.assertIsNone(self.run_sender(selection=selection))

    def test_df_timeline_and_late_clip_start(self):
        d=self.run_sender()
        self.assertAlmostEqual(d['fps'],30000/1001)
        self.assertTrue(d['drop_frame'])
        self.assertEqual((d['width'],d['height']),(3840,2160))
        self.assertEqual(d['pixel_aspect'],1)
        self.assertEqual(d['input_scaling'],'fill')
        self.assertEqual(d['display_start_frame'],227892)
        self.assertEqual(d['duration'],50)
        self.assertEqual(d['clips'][-1]['source_in'],100)
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
        self.assertEqual(d['clips'][-1]['source_in'],199)

    def test_no_audio_does_not_restore_embedded_sound(self):
        d=self.run_sender(audio=False)
        self.assertTrue(d['clips'][0]['mute_audio'])

    def test_ndf_does_not_become_df_because_of_source_tc(self):
        d=self.run_sender(fps='29.97')
        self.assertFalse(d['drop_frame'])

    def test_interlace_converts_field_ticks_without_changing_seconds(self):
        d=self.run_sender(fps='59.94',interlace='1',start=215784,span=(0,158),audio=False,drop='1')
        self.assertAlmostEqual(d['fps'],30000/1001)
        self.assertEqual(d['duration'],79)
        self.assertEqual(d['display_start_frame'],107892)
        self.assertEqual(d['resolve_ticks_per_frame'],2)
        self.assertAlmostEqual(d['duration']/d['fps'],158/(60000/1001))
        self.assertEqual(d['clips'][0]['duration'],79)
        self.assertTrue(d['drop_frame'])

    def test_progressive_5994_is_not_halved(self):
        d=self.run_sender(fps='59.94 DF',interlace='0',span=(0,158))
        self.assertAlmostEqual(d['fps'],60000/1001)
        self.assertEqual(d['duration'],158)
        self.assertTrue(d['drop_frame'])

    def test_interlace_pal_and_half_frame_clip_start(self):
        d=self.run_sender(fps='50',interlace='1',start=180000,span=(1,51))
        self.assertEqual(d['fps'],25)
        self.assertEqual(d['duration'],25)
        self.assertIsNone(d['display_start_frame'])
        self.assertAlmostEqual(d['display_start_time'],180001/50)

    def test_invalid_fps_does_not_silently_use_24(self):
        for raw in ['bogus', '0', '30000/0', '29.97 nonsense']:
            with self.subTest(raw=raw):
                self.assertIsNone(self.run_sender(fps=raw))

    def test_reports_resolve_speed_and_source_elapsed_time(self):
        for percentage in (100, 100.18, 50, 0, -100):
            with self.subTest(percentage=percentage):
                d = self.run_sender(fps='24', srcfps='55', span=(0,257), audio=False,
                                    speed_percentage=percentage, source_in_time=1.2345)
                c = d['clips'][0]
                self.assertEqual(c['src_frames'], 1000)
                self.assertEqual(c['source_in_time'], 1.2345)
                self.assertEqual(c['speed'], percentage / 100)
                self.assertEqual(d['warnings'], [])

    def test_one_timeline_frame_of_rounding_is_not_a_retime(self):
        source = SOURCE.replace('local used = usedA or usedB', 'local used = 590')
        d = self.run_sender(fps='24', srcfps='55', span=(0,257), audio=False, source=source)
        self.assertEqual(d['clips'][0]['speed'], 1)
        self.assertEqual(d['warnings'], [])

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
