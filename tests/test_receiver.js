/* Node mock-host regression tests; no Adobe application is launched. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname,'../r2ae_receive.jsx'),'utf8');
const acesTemplate = fs.readFileSync(path.join(__dirname,'../color/r2ae-aces-project.aet'),'latin1');
let checks=0;
function run(data, options={}) {
    const state={comps:[],imports:[],alerts:[],undo:0,importOptions:[],presetFolders:[]};
    const document=typeof data==='string'?data:JSON.stringify(data);
    function File(name) {
        this.fsName=name;this.name=path.basename(name);
        this.exists=(!name.startsWith('/mock/color/')||!options.missingColorAssets) &&
            (!name.startsWith('/mock/color/odt/')||!options.missingDisplayAsset);
    }
    File.prototype.open=function(){return true;};
    File.prototype.read=function(){return document;};
    File.prototype.close=function(){return true;};
    function Folder(name){return {fsName:name==='~/Documents/ae_bridge'?'/mock':name};}
    let nextID=1;
    function FolderItem(items=[]){this.id=nextID++;this.items=items;}
    Object.defineProperty(FolderItem.prototype,'numItems',{get(){return this.items.length;}});
    FolderItem.prototype.item=function(i){return this.items[i-1];};
    FolderItem.prototype.remove=function(){this.removed=true;};
    const rootFolder=new FolderItem();
    function FileSource(){this.isStill=!!options.still;this.conformFrameRate=0;this.fieldSeparationType='importer';}
    function FootageItem(){this.mainSource=new FileSource();this.nativeFps=options.nativeFps||60000/1001;
        this.id=nextID++;this.name='movie';
        this.hasVideo=options.hasVideo!==false;this.duration=options.sourceDuration||100;
        this.width=options.width||1920;this.height=options.height||1080;this.pixelAspect=1;}
    FootageItem.prototype.remove=function(){this.removed=true;};
    FootageItem.prototype.replace=function(file){
        this.mainSource.file=file;
        if(options.replacementPAR) this.pixelAspect=options.replacementPAR;
    };
    FootageItem.prototype.replaceWithSequence=function(file){
        this.replace(file);this.sequence=true;this.mainSource.conformFrameRate=24;
    };
    Object.defineProperty(FootageItem.prototype,'frameRate',{
        get(){return this.mainSource.conformFrameRate||this.nativeFps;},
        set(value){this.nativeFps=value;}
    });
    const existing=new FootageItem(); existing.mainSource.file=new File('/movie.mov'); existing.frameRate=12;
    function property(isSpatial=false){
        const keys=[];
        return {value:null, keys, isSpatial,
            setValue(v){this.value=v;},
            setValueAtTime(t,v){const k=keys.find(x=>Math.abs(x.t-t)<1e-10);if(k)k.v=v;else keys.push({t,v});keys.sort((a,b)=>a.t-b.t);},
            setValuesAtTimes(times, values){times.forEach((t,i)=>this.setValueAtTime(t,values[i]));},
            nearestKeyIndex(t){return keys.reduce((best,k,i)=>Math.abs(k.t-t)<Math.abs(keys[best].t-t)?i:best,0)+1;},
            get numKeys(){return keys.length;},keyTime(k){return keys[k-1].t;},
            removeKey(k){keys.splice(k-1,1);},setInterpolationTypeAtKey(){},
            setSpatialAutoBezierAtKey(){},setSpatialContinuousAtKey(){},keyInSpatialTangent(){return [1,2,3];},
            setSpatialTangentsAtKey(k,inTangent,outTangent){
                if(inTangent.length!==3 || outTangent.length!==3) throw new Error('AE requires a three-component tangent');
                keys[k-1].tangent=Array.from(inTangent);
            }};
    }
    const app={beginUndoGroup(){state.undo++;},endUndoGroup(){state.undo--;},
        beginSuppressDialogs(){},endSuppressDialogs(){},
        project:{numItems:options.numItems??1,rootFolder,item(){return existing;},items:{
            addFolder(){return new FolderItem();},
            addComp(name,w,h,par,duration,fps){
                const comp={name,width:w,height:h,pixelAspect:par,duration,frameRate:fps,
                    frameDuration:1/fps,list:[],comment:'',openInViewer(){},remove(){this.removed=true;}};
                comp.layers={add(footage){
                    const p={}, transformProps={};
                    const transform={property(name){
                        const valid=['ADBE Scale','ADBE Position','ADBE Anchor Point','ADBE Rotate Z','ADBE Opacity'];
                        if(!valid.includes(name) || options.missingTransformProperty===name)return null;
                        const spatial=name==='ADBE Position'||name==='ADBE Anchor Point';
                        return transformProps[name]||(transformProps[name]=property(spatial));
                    }};
                    const layer={footage,hasAudio:true,enabled:true,audioEnabled:true,stretch:100,
                        property(name){
                            if(name==='ADBE Transform Group')return transform;
                            if(name==='ADBE Time Remapping')return p[name]||(p[name]=property());
                            return null; // Transform children are not root match names.
                        },
                        remove(){this.removed=true;}};
                    Object.defineProperty(layer,'timeRemapEnabled',{set(v){
                        const tr=layer.property('ADBE Time Remapping');
                        if(v){tr.setValueAtTime(0,0);tr.setValueAtTime(footage.duration,footage.duration);}
                        else tr.keys.length=0;
                        this.remap=v;
                    }, get(){return this.remap;}});
                    comp.list.push(layer);return layer;
                }};state.comps.push(comp);return comp;
            }},
            importFile(io){
                if(io.importAs===2){
                    const seeds=['sony-cine','arri-logc3','arri-logc4','acescct','acescg','aces2065-1',
                        'bmd-film-gen5','canon-log2-cinemagamut','canon-log3-cinemagamut',
                        'red-log3g10-rwg','inverse-rec709-bt1886','inverse-srgb-piecewise'].map(name=>{
                        const f=new FootageItem(); f.name=name; f.preset=name; return f;
                    });
                    const folder=new FolderItem(seeds);
                    rootFolder.items.push(folder);
                    state.presetFolders.push(folder);
                    return existing; // AE 26.5 may return a previous item within an undo group.
                }
                state.importOptions.push(io);
                const f=new FootageItem();f.mainSource.file=io.file;state.imports.push(f);return f;
            }
        }};
    Object.assign(app.project,{colorManagementSystem:0,ocioConfigurationFile:'',bitsPerChannel:8},options.color);
    state.project=app.project;
    app.openTemplate=function(file){
        assert.equal(state.undo,0,'The template must open before the import undo group');
        state.templateOpened=file.fsName;
        state.templateBytes=fs.readFileSync(path.join(__dirname,'..',file.fsName.slice('/mock/'.length)),'latin1');
        return Object.assign(app.project,{
            colorManagementSystem:1,ocioConfigurationFile:'ACES 2.0 Studio v4.0',bitsPerChannel:32
        });
    };
    function ImportOptions(file){this.file=file;this.canImportAs=()=>true;}
    app.version=options.version||'26.5x89';
    const context={File,Folder,FolderItem,FileSource,FootageItem,ImportOptions,app,
        alert:s=>state.alerts.push(s),$: {os:options.os||'Macintosh',global:{r2aeColdStart:options.coldStart}},ImportAsType:{FOOTAGE:1,PROJECT:2},
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
test('the full 10-minute DF span preserves all 12 progressive cuts and source trims',()=>{
    const fps=30000/1001;
    const edges=Array.from({length:13},(_,i)=>Math.round(50*i*fps));
    const d=fixture({fps,duration:17982,display_start_frame:107892,interlaced:true});
    const source=d.clips[0];
    d.clips=edges.slice(0,-1).map((offset,i)=>({...source,path:`/test/progressive-${i}.mov`,
        offset,duration:edges[i+1]-offset,source_in:i%2,src_fps:fps,src_field:'Progressive'}));
    const comp=run(d,{nativeFps:fps}).comps[0];
    assert.equal(comp.frameRate,fps);
    assert.equal(comp.displayStartFrame,107892);
    assert.equal(comp.dropFrame,true);
    assert.equal(comp.duration,17982/fps);
    assert.equal(comp.list.length,12);
    for(const [i,layer] of comp.list.entries()) {
        assert.equal(Math.round(layer.inPoint*fps),edges[i]);
        assert.equal(Math.round(layer.outPoint*fps),edges[i+1]);
        assert.equal(Math.round((layer.inPoint-layer.startTime)*fps),i%2);
        assert.equal(layer.footage.mainSource.fieldSeparationType,0);
        assert.equal(layer.property('ADBE Time Remapping').keys.length,0);
    }
});
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
test('camera-confirmed fractional fps corrects AE rounding to whole fps',()=>{
    const d=fixture({fps:24000/1001});
    Object.assign(d.clips[0],{src_fps:d.fps,camera_fps:d.fps,src_field:'Progressive'});
    const s=run(d,{nativeFps:24}), l=s.comps[0].list[0];
    assert.equal(l.footage.frameRate,d.fps);
    assert.equal(l.startTime,-120/d.fps);
    assert.equal(l.property('ADBE Time Remapping').keys.length,0);
    assert.deepEqual(s.alerts,[]);

    d.clips[0].camera_fps=24;
    const deliberate=run(d,{nativeFps:24});
    assert.equal(deliberate.imports[0].frameRate,24);
    assert.equal(deliberate.comps[0].list[0].property('ADBE Time Remapping').keys.length,2);
    assert.equal(deliberate.alerts.length,1);
    assert.match(deliberate.alerts[0],/素材fps=.*Time Remap/);
});
test('A cold ACEScct transfer opens the project template before footage import',()=>{
    const d=fixture({aces:{mode:'acescct',version:''}});
    d.clips[0].src_idt='ARRI LogC3';
    const s=run(d,{numItems:0,coldStart:true});
    assert.equal(s.templateOpened,'/mock/color/r2ae-aces-project.aet');
    assert.equal(s.project.bitsPerChannel,32);
    assert.equal(s.comps[0].list[0].footage.preset,'arri-logc3');
    assert.deepEqual(s.alerts,[]);
});
test('Warm, older ACES and restored projects skip the startup template',()=>{
    const d=fixture({aces:{mode:'acescct',version:'aces_2.0',odt:'Rec.709 BT.1886'}});
    d.clips[0].src_idt='ARRI LogC3';
    const warm=run(d,{numItems:0,color:{workingSpace:'existing work',displayColorSpace:'existing display'}});
    assert.equal(warm.templateOpened,undefined);
    assert.equal(warm.project.workingSpace,'existing work');
    assert.equal(warm.project.displayColorSpace,'existing display');
    assert.equal(warm.project.ocioConfigurationFile,'');
    assert.equal(warm.project.bitsPerChannel,8);
    const restored=run(d,{numItems:0,coldStart:true,color:{file:{fsName:'/saved.aep'}}});
    assert.equal(restored.templateOpened,undefined);
    d.aces.version='aces_1.3';
    assert.equal(run(d,{numItems:0,coldStart:true}).templateOpened,undefined);
});
test('ACES 2.0 uses the stock configuration and assigns different IDTs to the same source',()=>{
    const d=fixture({aces:{version:'aces_2.0',mode:'acescct',odt:'Rec.709 - 100 nits'}});
    Object.assign(d.clips[0],{src_idt:'Sony SLog3 SGamut3Cine - CSC'});
    d.clips.push({...d.clips[0],name:'other IDT',src_idt:'ARRI LogC4 - CSC'});
    const s=run(d,{color:{colorManagementSystem:1,ocioConfigurationFile:'ACES 2.0 Studio v4.0',bitsPerChannel:32,
        workingSpace:'ACES/ACES2065-1',displayColorSpace:'existing display'}});
    assert.equal(s.project.colorManagementSystem,1);
    assert.equal(s.project.ocioConfigurationFile,'ACES 2.0 Studio v4.0');
    assert.equal(s.project.bitsPerChannel,32);
    assert.equal(s.project.workingSpace,'ACES/ACES2065-1');
    assert.equal(s.project.displayColorSpace,'existing display');
    assert.equal(s.templateOpened,undefined);
    assert.match(s.comps[0].comment,/Resolve ODT.*Rec\.709/);
    assert.deepEqual(s.comps[0].list.map(l=>l.footage.preset),['sony-cine','arri-logc4']);
    assert.match(s.comps[0].list[0].footage.comment,/Sony SLog3 SGamut3Cine/);
    assert.ok(s.presetFolders.every(f=>f.removed));
});
test('Cold starts match verified ACES display profiles and use the sRGB template otherwise',()=>{
    const defaultDisplay=['sRGB - Display','ACES 2.0 - SDR 100 nits (Rec.709)'];
    const d=fixture({aces:{mode:'acescct',version:'aces_2.0'}});
    d.clips[0].src_idt='ACEScct - CSC';
    const mappings=[
        ['sRGB Piecewise',...defaultDisplay],
        ['DisplayP3 Gamma 2.2',...defaultDisplay],
        ['unknown',...defaultDisplay],
        ['Rec.709 BT.1886','Rec.1886 Rec.709 - Display',defaultDisplay[1]],
        ['sRGB Gamma 2.2','Gamma 2.2 Rec.709 - Display',defaultDisplay[1]],
        ['DisplayP3','Display P3 - Display','ACES 2.0 - SDR 100 nits (P3 D65)'],
        ['P3-D65','P3-D65 - Display','ACES 2.0 - SDR 100 nits (P3 D65)'],
        ['Extended DisplayP3 (1000 nit)','Display P3 HDR - Display','ACES 2.0 - HDR 1000 nits (P3 D65)'],
    ];
    for(const n of [108,500,1000,2000,4000])
        mappings.push([`P3-D65 ST2084 (${n} nit)`,'ST2084-P3-D65 - Display',`ACES 2.0 - HDR ${n} nits (P3 D65)`]);
    for(const n of [500,1000,2000,4000])
        mappings.push([`Rec.2100 ST2084 (${n} nit)`,'Rec.2100-PQ - Display',`ACES 2.0 - HDR ${n} nits (Rec.2020)`]);

    const marker=acesTemplate.indexOf('pdvc');
    const profileStart=marker+18;
    const oldSize=Buffer.from(acesTemplate,'latin1').readUInt32BE(profileStart-4);
    for(const [odt,display,view] of mappings){
        d.aces.odt=odt;
        const s=run(d,{numItems:0,coldStart:true});
        const bytes=Buffer.from(s.templateBytes,'latin1');
        const size=bytes.readUInt32BE(profileStart-4);
        const profile=JSON.parse(s.templateBytes.slice(profileStart,profileStart+size));
        assert.deepEqual(JSON.parse(Buffer.from(profile.baseColorProfile.colorProfileData,'base64')),{
            colorSpace1:display,colorSpace2:view,ocioColorSpaceType:1
        },odt);
        assert.ok(s.comps[0].comment.includes(`AE Display Color Space: ${display} / ${view}`),odt);
        assert.equal(s.comps[0].list[0].footage.preset,'acescct');
        assert.equal(s.templateBytes.slice(8,profileStart-4),acesTemplate.slice(8,profileStart-4));
        assert.equal(s.templateBytes.slice(profileStart+size+size%2),acesTemplate.slice(profileStart+oldSize+oldSize%2));
        assert.equal(bytes.readUInt32BE(4)-Buffer.from(acesTemplate,'latin1').readUInt32BE(4),
            size+size%2-oldSize-oldSize%2);
    }
    d.aces.odt='Rec.709 BT.1886';
    const fallback=run(d,{numItems:0,coldStart:true,missingDisplayAsset:true});
    assert.equal(fallback.templateOpened,'/mock/color/r2ae-aces-project.aet');
    assert.match(fallback.alerts[0],/sRGBを使用/);
});
test('ACES maps supported camera and inverse display inputs',()=>{
    const color={colorManagementSystem:1,ocioConfigurationFile:'ACES 2.0 Studio v4.0'};
    const d=fixture({aces:{mode:'acescct'}});
    for(const [idt,preset] of [
        ['ACEScct - CSC','acescct'],
        ['Blackmagic Design Film Gen 5 - CSC','bmd-film-gen5'],
        ['Canon Log 2 Cinema Gamut - CSC','canon-log2-cinemagamut'],
        ['Canon Log 3 Cinema Gamut - CSC','canon-log3-cinemagamut'],
        ['RED Log3G10 REDWideGamutRGB - CSC','red-log3g10-rwg'],
        ['Inverse Rec.709 BT.1886','inverse-rec709-bt1886'],
        ['Inverse sRGB Piecewise','inverse-srgb-piecewise'],
        ['Inverse sRGB Gamma 2.2','inverse-srgb-piecewise'],
        ['Inverse Rec.709 BT.1886 (D60 simulation)',undefined],
        ['sRGB',undefined],
        ['Rec.709',undefined],
        ['Canon Log 2 Rec.2020 - CSC',undefined],
        ['Fujifilm F-Log2',undefined],
    ]){
        d.clips[0].src_idt=idt;
        const state=run(d,{color});
        assert.equal(state.comps[0].list[0].footage.preset,preset,idt);
        if(!preset) assert.ok(state.alerts[0].includes(idt));
    }
});
test('ACES preserves sequence fps and falls back when the preset changes pixel aspect',()=>{
    const d=fixture({aces:{version:'ACES 2.0'}});
    Object.assign(d.clips[0],{path:'/exr/0001.exr',is_sequence:true,src_fps:25,src_idt:'ACEScg - CSC'});
    const color={colorManagementSystem:1,ocioConfigurationFile:'ACES 2.0 Studio v4.0'};
    const ok=run(d,{color});
    const footage=ok.comps[0].list[0].footage;
    assert.equal(footage.preset,'acescg');
    assert.equal(footage.sequence,true);
    assert.equal(footage.frameRate,25);
    const fallback=run(d,{color,replacementPAR:2});
    assert.equal(fallback.comps[0].list[0].footage,fallback.imports[0]);
    assert.match(fallback.alerts[0],/IDTを確認.*映像・音声属性/);
    assert.ok(fallback.presetFolders.every(f=>f.removed));
});
test('ACES with no Resolve version uses LogC3 only in a stock ACES 2.0 project',()=>{
    const d=fixture({aces:{mode:'acescct',version:''}});
    d.clips[0].src_idt='ARRI LogC3';
    const blank=run(d,{numItems:0});
    assert.equal(blank.presetFolders.length,0);
    assert.match(blank.alerts[0],/AE標準のACES 2.0 Studio/);
    const stock=run(d,{color:{colorManagementSystem:1,ocioConfigurationFile:'ACES 2.0 Studio v4.0'}});
    assert.equal(stock.comps[0].list[0].footage.preset,'arri-logc3');
});
test('ACES keeps existing unrelated project settings',()=>{
    const d=fixture({aces:{version:'aces_2.0'}});
    d.clips[0].src_idt='ARRI LogC3 (EI800) - CSC';
    const s=run(d,{color:{colorManagementSystem:1,ocioConfigurationFile:'Pipeline.ocio'}});
    assert.equal(s.project.ocioConfigurationFile,'Pipeline.ocio');
    assert.equal(s.presetFolders.length,0);
    assert.match(s.alerts[0],/AE標準のACES 2.0 Studio/);
    assert.equal(s.comps[0].list.length,1);
});
test('video order follows start times from the bottom while overlapping upper tracks stay above',()=>{
    const video=(name,track,offset,duration,extra={})=>({
        ...fixture().clips[0],name,track,offset,duration,...extra
    });
    const d=fixture({duration:100},[
        video('bottom',1,10,30),video('last',3,60,10),video('first',1,0,10),
        video('overlap',2,20,7),video('top',3,23,5),video('after',1,40,5),
        video('early upper',3,48,10),video('late lower',1,50,8),
        video('sound',1,0,10,{kind:'audio'})
    ]);
    const topFirst=run(d).comps[0].list.slice().reverse();
    assert.deepEqual(topFirst.map(l=>l.name),[
        '[V3] last','[V3] early upper','[V1] late lower','[V1] after',
        '[V3] top','[V2] overlap','[V1] bottom','[V1] first','[A1] sound'
    ]);
});
test('orientation, scaling and inspector transforms use the original footage layer',()=>{
    const d=fixture({fps:24});
    Object.assign(d.clips[0],{src_w:2160,src_h:3840,source_rotation:90,
        transform:{zoom_x:1.2,zoom_y:0.8,anchor_x:100,anchor_y:50,flip_x:true},
        transform_keys:{rotation:[[0,0],[1,20]]}});
    const s=run(d,{width:2160,height:3840});
    const l=s.comps[0].list[0];
    assert.equal(s.comps.length,1);
    assert.equal(l.footage,s.imports[0]);
    const t=l.property('ADBE Transform Group');
    assert.deepEqual(Array.from(t.property('ADBE Scale').value),[40,-60]);
    assert.deepEqual(Array.from(t.property('ADBE Anchor Point').value),[980,1720]);
    assert.deepEqual(t.property('ADBE Rotate Z').keys.map(k=>k.v),[90,110]);

    d.input_scaling='stretch';
    d.height=960;
    d.clips[0].source_rotation=-90;
    d.clips[0].transform={};
    delete d.clips[0].transform_keys;
    const stretched=run(d,{width:2160,height:3840});
    const transform=stretched.comps[0].list[0].property('ADBE Transform Group');
    assert.equal(stretched.comps.length,1);
    assert.deepEqual(Array.from(transform.property('ADBE Scale').value),[960/2160*100,50]);
    assert.equal(transform.property('ADBE Rotate Z').value,-90);

    d.input_scaling='none';
    const original=run(d,{width:2160,height:3840});
    assert.equal(original.comps.length,1);
    assert.deepEqual(Array.from(original.comps[0].list[0].property('ADBE Transform Group').property('ADBE Scale').value),
        [100,100]);
});
test('Fit scales the direct footage layer without creating another composition',()=>{
    const s=run(fixture(),{width:2160,height:3840});
    const l=s.comps[0].list[0];
    assert.equal(s.comps.length,1);
    assert.equal(l.footage,s.imports[0]);
    assert.deepEqual(Array.from(l.property('ADBE Transform Group').property('ADBE Scale').value),
        [28.125,28.125]);
});
test('VFR is placed by elapsed time while preserving deliberate speed changes',()=>{
    const d=fixture({fps:24,duration:257});
    Object.assign(d.clips[0],{src_fps:55,src_frames:590,source_in:55,source_in_time:0.98,
        duration:100,src_field:'Progressive'});
    const options={width:2880,height:1800,nativeFps:56.261962890625,sourceDuration:10.7354875404358};
    const s=run(d,options);
    const l=s.comps[0].list[0];
    assert.equal(l.startTime,-0.98);
    assert.equal(l.property('ADBE Time Remapping').keys.length,0);
    assert.deepEqual(s.alerts,[]);
    d.clips[0].speed=2;
    const fast=run(d,options).comps[0].list[0].property('ADBE Time Remapping').keys;
    assert.equal(fast[0].v,0.98);
    assert.ok(Math.abs((fast[1].v-fast[0].v)/(fast[1].t-fast[0].t)-2)<1e-10);
});
test('direct footage reuse preserves separate audio, trim, and retime',()=>{
    const d=fixture({fps:24,duration:80});
    Object.assign(d.clips[0],{src_fps:24,duration:20,source_in:10});
    d.clips.push({...d.clips[0],offset:30,speed:2});
    d.clips.push({...d.clips[0],offset:10,kind:'audio',mute_audio:false});
    const s=run(d,{nativeFps:24,width:1280,height:720});
    const [audio,first,second]=s.comps[0].list;
    assert.equal(s.comps.length,1);
    assert.ok([audio,first,second].every(layer=>layer.footage===s.imports[0]));
    assert.equal(first.audioEnabled,false);
    assert.equal(first.startTime,-10/24);
    assert.equal(second.inPoint,30/24);
    assert.equal(second.outPoint,50/24);
    const keys=second.property('ADBE Time Remapping').keys;
    assert.ok(Math.abs((keys[1].v-keys[0].v)/(keys[1].t-keys[0].t)-2)<1e-10);
    assert.deepEqual(Array.from(first.property('ADBE Transform Group').property('ADBE Scale').value),[150,150]);
});
test('a direct still layer spans the edit even when source IN exceeds the importer duration',()=>{
    const d=fixture({fps:24,duration:80});
    Object.assign(d.clips[0],{source_in:72,src_fps:24,duration:48,speed:0});
    const s=run(d,{still:true,width:1280,height:720,sourceDuration:1});
    const layer=s.comps[0].list[0];
    assert.equal(s.comps.length,1);
    assert.equal(layer.footage,s.imports[0]);
    assert.equal(layer.startTime,-3);
    assert.equal(layer.outPoint,2);
    assert.equal(layer.property('ADBE Time Remapping').keys.length,0);
});
test('retime key clipping preserves slope and layer duration',()=>{
    const d=fixture();d.clips[0].speed=-1;d.clips[0].source_in=29;d.clips[0].src_fps=30000/1001;
    const c=run(d,{nativeFps:30000/1001}).comps[0],l=c.list[0],keys=l.property('ADBE Time Remapping').keys;
    assert.equal(keys.length,2);assert.ok(Math.abs((keys[1].v-keys[0].v)/(keys[1].t-keys[0].t)+1)<1e-10);
    assert.equal(l.outPoint,c.duration);
});
test('Nearest reproduces mixed-rate variable speed, freezes and reverse at comp frame times',()=>{
    const d=fixture({fps:24, duration:12});
    const clips=d.clips;
    Object.assign(clips[0],{offset:3,duration:8,source_in:8,src_fps:30,src_frames:180,
        src_field:'Progressive',speed:1,
        retime_keys:[[0,8/30],[3/24,13/30],[5/24,13/30],[7/24,9/30]]});
    const l=run(d,{nativeFps:30,sourceDuration:6}).comps[0].list[0];
    const keys=l.property('ADBE Time Remapping').keys;
    const output=[];
    for(let i=3;i<11;i++){
        const t=i/24;
        const index=keys.findIndex(key=>key.t>=t);
        const b=keys[index], a=keys[Math.max(0,index-1)];
        output.push(Math.floor(30*(a===b?a.v:a.v+(b.v-a.v)*(t-a.t)/(b.t-a.t))));
    }
    assert.deepEqual(output,[8,9,11,13,13,13,11,9]);
    assert.equal(l.inPoint,3/24);
    assert.equal(l.outPoint,11/24);
    assert.ok(keys.length<output.length);
});
test('a one-frame remap keeps only the intended source key',()=>{
    const d=fixture({fps:24,duration:20});
    Object.assign(d.clips[0],{offset:17,duration:1,source_in:12,src_fps:24,
        speed:0,retime_keys:[[0,0.5],[1/24,0.5]]});
    const l=run(d,{nativeFps:24}).comps[0].list[0];
    assert.deepEqual(l.property('ADBE Time Remapping').keys,[{t:17/24,v:12.25/24}]);
    assert.equal(l.outPoint,18/24);
});
test('Nearest handles Resolve rounding just below a source frame boundary',()=>{
    const d=fixture({fps:24,duration:3});
    const srcFps=24000/1001;
    Object.assign(d.clips[0],{source_in:38,src_fps:srcFps,duration:3,speed:2,
        retime_keys:[[0,38/srcFps],[3/24,38/srcFps+6/24]]});
    const l=run(d,{nativeFps:srcFps}).comps[0].list[0];
    const keys=l.property('ADBE Time Remapping').keys;
    assert.deepEqual(keys.map(key=>Math.floor(key.v*srcFps)),[38,40,41]);
});
test('frame count mismatch falls back and reports that exact mapping could not be applied',()=>{
    const d=fixture({fps:24,duration:24});
    Object.assign(d.clips[0],{source_in:12,src_fps:24,src_frames:520,duration:24,
        speed:2,retime_keys:[[0,0.5],[1,2.5]]});
    const s=run(d,{nativeFps:24,sourceDuration:20});
    const l=s.comps[0].list[0];
    assert.match(s.alerts.join('\n'),/コマ合わせに失敗/);
    assert.deepEqual(l.property('ADBE Time Remapping').keys,[{t:0,v:0.5},{t:1,v:2.5}]);
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
    const d=fixture();d.clips[0].src_field='Upper Field';
    d.clips.push({...d.clips[0],src_field:'Lower Field'});
    const s=run(d);assert.equal(s.imports.length,2);
    assert.deepEqual(s.imports.map(item=>item.mainSource.fieldSeparationType).sort(),[1,2]);
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
    const l=run(d,{width:3840,height:2160}).comps[0].list[0],t=l.property('ADBE Transform Group');
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
test('animation preserves original keys outside layer trim and comp bounds',()=>{
    const d=fixture({fps:24,duration:48});
    Object.assign(d.clips[0],{offset:24,duration:24,source_in:0,src_fps:24,
        transform:{flip_x:true}, transform_keys:{
            position:[[-1.5,0,0],[.5,100,20]], anchor:[[.75,50,-10]],
            scale:[[0,1,1],[1,1.5,1.25]], rotation:[[.25,-20],[.75,0]], amount:[[.5,75],[1.5,0]]
        }});
    const c=run(d,{nativeFps:24}).comps[0], l=c.list[0];
    const t=l.property('ADBE Transform Group');
    const keys=name=>t.property(name).keys.map(({t,v})=>[t,Array.isArray(v)?Array.from(v):v]);
    assert.deepEqual(keys('ADBE Position'),[[-.5,[1010,550]],[1.5,[1110,530]],[1.75,[1110,530]]]);
    assert.deepEqual(keys('ADBE Anchor Point'),[[1.75,[1010,550]]]);
    assert.deepEqual(keys('ADBE Scale'),[[1,[-100,100]],[2,[-150,125]]]);
    assert.deepEqual(keys('ADBE Rotate Z'),[[1.25,-20],[1.75,0]]);
    assert.deepEqual(keys('ADBE Opacity'),[[1.5,75],[2.5,0]]);
    assert.equal(l.inPoint,1);
    assert.equal(l.outPoint,2);
    assert.equal(c.duration,2);
    assert.deepEqual(t.property('ADBE Position').keys[0].tangent,[0,0,0]);
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
