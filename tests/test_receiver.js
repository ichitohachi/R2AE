/* Node mock-host regression tests; no Adobe application is launched. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname,'../r2ae_receive.jsx'),'utf8');
let checks=0;
function run(data, options={}) {
    const state={comps:[],imports:[],alerts:[],undo:0,importOptions:[]};
    const document=typeof data==='string'?data:JSON.stringify(data);
    function File(name) { this.fsName=name; this.exists=true; this.name=name; }
    File.prototype.open=function(){return true;};
    File.prototype.read=function(){return document;};
    File.prototype.close=function(){};
    function Folder(){return {fsName:'/mock'};}
    function FolderItem(){}
    function FileSource(){this.isStill=false;this.conformFrameRate=0;this.fieldSeparationType='importer';}
    function FootageItem(){this.mainSource=new FileSource();this.frameRate=options.nativeFps||60000/1001;
        this.hasVideo=options.hasVideo!==false;this.duration=options.sourceDuration||100;this.width=1920;this.height=1080;}
    const existing=new FootageItem(); existing.mainSource.file=new File('/movie.mov'); existing.frameRate=12;
    function property(){
        const keys=[];
        return {value:null, keys,
            setValue(v){this.value=v;},
            setValueAtTime(t,v){const k=keys.find(x=>Math.abs(x.t-t)<1e-10);if(k)k.v=v;else keys.push({t,v});keys.sort((a,b)=>a.t-b.t);},
            get numKeys(){return keys.length;},keyTime(k){return keys[k-1].t;},
            removeKey(k){keys.splice(k-1,1);},setInterpolationTypeAtKey(){}};
    }
    const app={beginUndoGroup(){state.undo++;},endUndoGroup(){state.undo--;},
        project:{numItems:1,item(){return existing;},items:{
            addFolder(){return new FolderItem();},
            addComp(name,w,h,par,duration,fps){
                const comp={name,width:w,height:h,pixelAspect:par,duration,frameRate:fps,list:[],comment:'',openInViewer(){}};
                comp.layers={add(footage){
                    const p={}, transformProps={};
                    const transform={property(name){
                        const valid=['ADBE Scale','ADBE Position','ADBE Anchor Point','ADBE Rotate Z','ADBE Opacity'];
                        if(!valid.includes(name) || options.missingTransformProperty===name)return null;
                        return transformProps[name]||(transformProps[name]=property());
                    }};
                    const layer={footage,hasAudio:true,enabled:true,audioEnabled:true,stretch:100,
                        property(name){
                            if(name==='ADBE Transform Group')return transform;
                            if(name==='ADBE Time Remapping')return p[name]||(p[name]=property());
                            return null; // Transform children are not root match names.
                        },
                        remove(){this.removed=true;}};
                    Object.defineProperty(layer,'timeRemapEnabled',{set(v){
                        if(v){const tr=layer.property('ADBE Time Remapping');tr.setValueAtTime(0,0);tr.setValueAtTime(footage.duration,footage.duration);}
                    }});
                    comp.list.push(layer);return layer;
                }};state.comps.push(comp);return comp;
            }},
            importFile(io){state.importOptions.push(io);const f=new FootageItem();f.mainSource.file=io.file;state.imports.push(f);return f;}
        }};
    function ImportOptions(file){this.file=file;this.canImportAs=()=>true;}
    const context={File,Folder,FolderItem,FileSource,FootageItem,ImportOptions,app,
        alert:s=>state.alerts.push(s),$: {os:options.os||'Macintosh'},ImportAsType:{FOOTAGE:1},
        FieldSeparationType:{OFF:0,UPPER_FIELD_FIRST:1,LOWER_FIELD_FIRST:2},
        KeyframeInterpolationType:{LINEAR:1}};
    vm.runInNewContext(source,context);
    assert.equal(state.undo,0,'Undo group must close');
    return state;
}
function fixture(overrides={}, clips){return {schema_version:2,fps:30000/1001,width:1920,height:1080,duration:30,
    drop_frame:true,display_start_frame:107892,pixel_aspect:1,warnings:[],input_scaling:'fit',
    clips:clips||[{name:'clip',path:'/movie.mov',kind:'video',track:1,offset:0,duration:30,source_in:120,
        speed:1,src_fps:60000/1001,src_field:'Upper Field First',mute_audio:true,
        transform:{flip_x:0,flip_y:0}}],...overrides};}
function test(name,fn){fn();checks++;console.log('PASS',name);}
test('mixed fps, DF and original media are independent',()=>{
    const s=run(fixture());const c=s.comps[0], l=c.list[0];
    assert.equal(c.frameRate,30000/1001);assert.equal(c.dropFrame,true);assert.equal(c.displayStartFrame,107892);
    assert.equal(l.footage.frameRate,60000/1001);assert.equal(l.startTime,-120/(60000/1001));
    assert.equal(l.outPoint,30/(30000/1001));assert.equal(l.audioEnabled,false);
    assert.equal(l.footage.mainSource.fieldSeparationType,1);
    assert.deepEqual(Array.from(l.property('ADBE Transform Group').property('ADBE Scale').value),[100,100]);
});
test('A track video is disabled while audio remains enabled',()=>{
    const d=fixture();d.clips[0].kind='audio';d.clips[0].mute_audio=false;
    const l=run(d).comps[0].list[0];assert.equal(l.enabled,false);assert.equal(l.audioEnabled,true);
});
test('source interpretation changes are layer retiming, not footage conforming',()=>{
    const d=fixture();d.clips[0].src_fps=30000/1001;
    const l=run(d).comps[0].list[0];const keys=l.property('ADBE Time Remapping').keys;
    assert.equal(l.footage.mainSource.conformFrameRate,0);
    assert.ok(Math.abs((keys[1].v-keys[0].v)/(keys[1].t-keys[0].t)-0.5)<1e-10);
});
test('retime key clipping preserves slope and layer duration',()=>{
    const d=fixture();d.clips[0].speed=-1;d.clips[0].source_in=29;d.clips[0].src_fps=30000/1001;
    const c=run(d,{nativeFps:30000/1001}).comps[0],l=c.list[0],keys=l.property('ADBE Time Remapping').keys;
    assert.equal(keys.length,2);assert.ok(Math.abs((keys[1].v-keys[0].v)/(keys[1].t-keys[0].t)+1)<1e-10);
    assert.equal(l.outPoint,c.duration);
});
test('invalid retime removes partial layer instead of substituting normal speed',()=>{
    const d=fixture();d.clips[0].speed=2;d.clips[0].source_in=-10;
    const s=run(d);assert.equal(s.comps[0].list[0].removed,true);assert.ok(s.alerts.some(x=>x.includes('速度適用失敗')));
});
test('per-transfer cache avoids existing manually interpreted footage',()=>{
    const d=fixture();d.clips.push({...d.clips[0],offset:10,duration:20});
    const s=run(d);assert.equal(s.imports.length,1);assert.equal(s.comps[0].list[0].footage.frameRate,60000/1001);
});
test('field variants of the same file are imported independently',()=>{
    const d=fixture();d.clips.push({...d.clips[0],src_field:'Lower Field First'});
    const s=run(d);assert.equal(s.imports.length,2);assert.equal(s.imports[1].mainSource.fieldSeparationType,2);
});
test('sequence uses Resolve source fps only',()=>{
    const d=fixture();d.clips[0].is_sequence=true;d.clips[0].src_fps=25;
    assert.equal(run(d).imports[0].mainSource.conformFrameRate,25);
});
test('JSON parser accepts escaped Unicode and rejects code, malformed numbers and trailing input',()=>{
    const d=fixture();d.clips[0].name='日本語\n"x"';assert.equal(run(d).comps.length,1);
    for (const bad of ['({clips:[]})','{"fps":01}','{"fps":NaN}','{"x":1,}','{"x":"\\x41"}',
        '{"x":1} alert("injected")','{"__proto__":{}}']){
        const s=run(bad);assert.equal(s.comps.length,0);assert.ok(s.alerts.some(x=>x.includes('解析に失敗')));
    }
});
test('audio-only retime uses stretch',()=>{
    const d=fixture();d.clips[0].speed=2;d.clips[0].kind='audio';
    assert.equal(run(d,{hasVideo:false}).comps[0].list[0].stretch,50);
});
test('nondefault Resolve scale position anchor and rotation are applied through Transform',()=>{
    const d=fixture();Object.assign(d.clips[0],{src_w:3840,src_h:2160,
        transform:{zoom_x:0.32,zoom_y:0.32,pan:0,tilt:0,anchor_x:-950,anchor_y:478,rotation:35.73,opacity:70}});
    const l=run(d).comps[0].list[0],t=l.property('ADBE Transform Group');
    assert.deepEqual(Array.from(t.property('ADBE Scale').value),[16,16]);
    assert.deepEqual(Array.from(t.property('ADBE Position').value),[10,62]);
    assert.deepEqual(Array.from(t.property('ADBE Anchor Point').value),[20,124]);
    assert.equal(t.property('ADBE Rotate Z').value,35.73);
    assert.equal(t.property('ADBE Opacity').value,70);
});
test('missing Transform property is reported instead of silently ignoring all transforms',()=>{
    const s=run(fixture(),{missingTransformProperty:'ADBE Scale'});
    assert.ok(s.alerts.some(x=>x.includes('ADBE Scale')));
    assert.equal(s.comps[0].list[0].removed,true);
});
test('Windows sequence and spaced Unicode path retain source fps and Transform',()=>{
    const d=fixture();Object.assign(d.clips[0],{path:'C:\\Users\\Editor Name\\素材\\shot_0001.exr',
        is_sequence:true,src_fps:24,src_field:'Progressive',transform:{zoom_x:0.5,zoom_y:0.5,pan:100,tilt:20}});
    const s=run(d,{os:'Windows',nativeFps:24});
    assert.equal(s.importOptions[0].sequence,true);
    assert.equal(s.importOptions[0].file.fsName,d.clips[0].path);
    assert.equal(s.imports[0].mainSource.conformFrameRate,24);
    assert.equal(s.imports[0].mainSource.fieldSeparationType,0);
    const t=s.comps[0].list[0].property('ADBE Transform Group');
    assert.deepEqual(Array.from(t.property('ADBE Scale').value),[50,50]);
    assert.deepEqual(Array.from(t.property('ADBE Position').value),[1060,520]);
});
console.log(`${checks} receiver tests passed`);
