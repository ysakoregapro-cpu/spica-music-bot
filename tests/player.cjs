const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TrackQueue } = require('../dist/music/TrackQueue.js');
const { GuildPlayer } = require('../dist/music/GuildPlayer.js');
const { MusicManager } = require('../dist/music/MusicManager.js');
const { handlePlayerButton, controls, panelPayload, sendWelcome } = require('../dist/music/PlayerPanel.js');
const { ensureAutoPanel, refreshPanel, forgetPanel } = require('../dist/music/PlayerPanel.js');
const track = (title) => ({ title, url: `https://www.youtube.com/watch?v=${title}`, duration: 120, requestedBy: 'test' });

test('previous restores current ahead of waiting tracks and preserves repeat pool', () => {
  for (const mode of ['off', 'one', 'list', 'shuffle']) {
    const q = new TrackQueue();
    const [a,b,c] = ['a','b','c'].map(track);
    q.enqueue([a,b,c]); q.setRepeatMode(mode); q.takeNextTrack();
    q.completeCurrentTrackNaturalEnd();
    q.returnToPrevious(a);
    assert.equal(q.current, a);
    assert.equal(q.takeNextTrack(), b);
    assert.equal(q.takeNextTrack(), c);
    assert.equal(q.repeatPool.length, 3);
    assert.equal(q.repeatMode, mode);
  }
});

test('previous after skip restores the skipped track without dropping the current one', () => {
  const q = new TrackQueue(); const [a,b,c] = ['a','b','c'].map(track);
  q.enqueue([a,b,c]); q.takeNextTrack(); q.takeNextTrack(); q.returnToPrevious(a);
  assert.equal(q.current, a); assert.equal(q.takeNextTrack(), b); assert.equal(q.takeNextTrack(), c);
});

test('default natural repeat rotates; shuffle cycle keeps every entry', () => {
  const q = new TrackQueue(); const items = ['a','b','c'].map(track);
  q.enqueue(items); q.takeNextTrack();
  assert.equal(q.completeCurrentTrackNaturalEnd(), items[1]);
  assert.equal(q.completeCurrentTrackNaturalEnd(), items[2]);
  assert.equal(q.completeCurrentTrackNaturalEnd(), items[0]);
  q.setRepeatMode('shuffle');
  for(let i=0;i<3;i++) q.completeCurrentTrackNaturalEnd();
  assert.deepEqual(new Set([q.current,...q.upcoming]), new Set(items));
});

test('mute changes only voice connection flags, remains independent by guild, and resets on leave', () => {
  const manager = new MusicManager();
  const a = manager.getOrCreate('a'), b = manager.getOrCreate('b');
  let options;
  a.connection = { joinConfig: { channelId:'vc', guildId:'a', selfDeaf:true, selfMute:false }, rejoin: (value) => {options=value;return true;}, destroy(){} };
  const current = track('a'); a.queue.setCurrent(current);
  a.setMuted(true);
  assert.equal(a.isMuted,true); assert.equal(b.isMuted,false); assert.equal(a.queue.current,current);
  assert.equal(options.selfMute,true); assert.equal(options.channelId,'vc'); assert.equal(options.selfDeaf,true);
  a.disconnect(); assert.equal(a.isMuted,false);
  assert.throws(() => b.setMuted(true));
});

test('buttons reject people outside bot VC and DMs without changing playback', async () => {
  const manager = new MusicManager(); const p = manager.getOrCreate('guild');
  p.connection = {}; p.voiceChannelId = 'bot-vc';
  let reply;
  await handlePlayerButton({ customId:'spica:mute', guildId:'guild', user:{id:'u'}, guild:{ members:{ fetch:async()=>({voice:{channelId:'other-vc'}}) } }, reply:async(value)=>{reply=value;} },manager);
  assert.equal(reply.ephemeral,true); assert.equal(p.isMuted,false);
  await handlePlayerButton({customId:'spica:next',guildId:null,user:{id:'u'},reply:async(value)=>{reply=value;}},manager);
  assert.equal(reply.ephemeral,true);
});

test('mute menu has exactly mute and unmute; payload escapes mentions and reflects guild', () => {
  assert.deepEqual(controls(false,true)[0].toJSON().components.map(x=>x.custom_id),['spica:mute','spica:unmute']);
  const m = new MusicManager(); const p=m.getOrCreate('a'); p.connection={}; p.queue.setCurrent(track('song'));
  assert.equal(panelPayload(m,'a').embeds[0].toJSON().title,'song');
  assert.equal(panelPayload(m,'b').embeds[0].toJSON().title,'再生待機中');
  assert.deepEqual(panelPayload(m,'a').allowedMentions.parse,[]);
});

test('welcome falls back to writable channel and sends only once',async()=>{
  let sent=0;
  const channel=(id,allowed)=>({id,isTextBased:()=>true,isSendable:()=>true,isThread:()=>false,permissionsFor:()=>({has:()=>allowed}),send:async(payload)=>{sent++;assert.equal(payload.components[0].toJSON().components.length,4);}});
  const g={id:'welcome-test',members:{fetchMe:async()=>({})},systemChannel:channel('system',false),channels:{fetch:async()=>new Map([['ok',channel('ok',true)]])}};
  await sendWelcome(g); await sendWelcome(g); assert.equal(sent,1);
});

test('same VC can mute; transitions and concurrent button actions are rejected', async () => {
  const m = new MusicManager(); const p = m.getOrCreate('buttons');
  p.connection = {joinConfig:{channelId:'vc',selfDeaf:true},rejoin:()=>true}; p.voiceChannelId='vc';
  const replies=[];
  const interaction=(action)=>({customId:`spica:${action}`,guildId:'buttons',user:{id:'u'},guild:{members:{fetch:async()=>({voice:{channelId:'vc'}})}},deferReply:async()=>{},editReply:async(v)=>replies.push(v)});
  await handlePlayerButton(interaction('mute'),m); assert.equal(p.isMuted,true);
  await handlePlayerButton(interaction('unmute'),m); assert.equal(p.isMuted,false);
  p.idleAdvanceBlocked=true;
  await handlePlayerButton(interaction('mute'),m); assert.equal(p.isMuted,false);
  p.idleAdvanceBlocked=false;
  let release; p.skip=()=>new Promise(resolve=>{release=resolve;});
  const first=handlePlayerButton(interaction('next'),m);
  await new Promise(resolve=>setImmediate(resolve));
  await handlePlayerButton(interaction('mute'),m); assert.equal(p.isMuted,false);
  release(null); await first;
});

test('automatic panel is sent once and edits reflect track changes', async () => {
  const m=new MusicManager(); const p=m.getOrCreate('panel'); p.connection={};
  let sent=0; const edits=[];
  const channel={send:async()=>{sent++;return {edit:async(payload)=>edits.push(payload.embeds[0].toJSON().title)};}};
  ensureAutoPanel(m,'panel',channel); ensureAutoPanel(m,'panel',channel);
  await new Promise(resolve=>setImmediate(resolve));
  p.queue.setCurrent(track('first')); refreshPanel(m,'panel');
  await new Promise(resolve=>setImmediate(resolve));
  p.queue.setCurrent(track('second')); refreshPanel(m,'panel');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(sent,1); assert.deepEqual(edits,['first','second']); forgetPanel('panel');
});

test('rewind keeps history order and stop resets history and mute', async () => {
  const p=new GuildPlayer('rewind'); const [a,b,c]=['a','b','c'].map(track);
  p.queue.enqueue([a,b,c]); p.queue.takeNextTrack(); p.queue.takeNextTrack(); p.queue.takeNextTrack();
  p.history=[a,b]; p.lastStarted=c;
  p.play=async(t)=>{p.queue.setCurrent(t);p.idleAdvanceBlocked=false;};
  await p.previous(); assert.equal(p.queue.current,b); assert.equal(p.queue.peekNext(),c);
  await p.previous(); assert.equal(p.queue.current,a); assert.equal(p.queue.peekNext(),b);
  assert.equal(p.canGoBack,false);
  p.muted=true; await p.stop(); assert.equal(p.isMuted,false); assert.equal(p.canGoBack,false);
});
