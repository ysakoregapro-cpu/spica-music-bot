const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TrackQueue } = require('../dist/music/TrackQueue.js');
const { GuildPlayer } = require('../dist/music/GuildPlayer.js');
const { MusicManager } = require('../dist/music/MusicManager.js');
const { handlePlayerButton, controls, panelPayload, sendWelcome } = require('../dist/music/PlayerPanel.js');
const { ensureAutoPanel, refreshPanel, forgetPanel } = require('../dist/music/PlayerPanel.js');
const { musicResolverItemsToTracks } = require('../dist/music/youtubeMusicResolver.js');
const {
  extractYouTubeThumbnailUrl, resolveTrackThumbnail, resolveTrackWatchUrl, youtubeMediaFields,
} = require('../dist/music/youtubeThumbnail.js');
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
  const channel=(id,allowed)=>({id,isTextBased:()=>true,isSendable:()=>true,isThread:()=>false,permissionsFor:()=>({has:()=>allowed}),send:async(payload)=>{sent++;assert.deepEqual(payload.components[0].toJSON().components.map(x=>x.custom_id),['spica:personal-mute','spica:personal-unmute']);}});
  const g={id:'welcome-test',members:{fetchMe:async()=>({})},systemChannel:channel('system',false),channels:{fetch:async()=>new Map([['ok',channel('ok',true)]])}};
  await sendWelcome(g); await sendWelcome(g); assert.equal(sent,1);
});

test('personal mute guidance works before voice join without accessing voice state', async () => {
  for (const action of ['personal-mute','personal-unmute']) {
    let reply;
    await handlePlayerButton({customId:`spica:${action}`,reply:async(v)=>{reply=v;}},new MusicManager());
    assert.equal(reply.ephemeral,true);
    assert.match(reply.content,/設定はまだ変更されていません/);
  }
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

const VIDEO_A = 'abcdefghijk';
const VIDEO_B = 'zyxwvutsrqp';
const playing = (title, extra) => ({ title, url: extra.url, duration: extra.duration, requestedBy: 'test', ...extra });

test('thumbnail prefers track fields, then the watch URL, and stays optional', () => {
  const preferred = playing('Preferred', {
    url: `https://music.youtube.com/watch?v=${VIDEO_B}`,
    duration: 90,
    videoId: VIDEO_A,
    thumbnail: `https://i.ytimg.com/vi/${VIDEO_A}/maxresdefault.jpg`,
  });
  assert.equal(resolveTrackThumbnail(preferred), `https://i.ytimg.com/vi/${VIDEO_A}/maxresdefault.jpg`);
  assert.equal(resolveTrackWatchUrl(preferred), `https://www.youtube.com/watch?v=${VIDEO_A}`);

  const fromId = playing('From id', { url: 'https://example.com/not-a-video', duration: 10, videoId: VIDEO_A });
  assert.equal(resolveTrackThumbnail(fromId), `https://i.ytimg.com/vi/${VIDEO_A}/hqdefault.jpg`);
  assert.equal(resolveTrackWatchUrl(fromId), `https://www.youtube.com/watch?v=${VIDEO_A}`);

  for (const url of [
    `https://www.youtube.com/watch?v=${VIDEO_B}&list=PLxxxx`,
    `https://youtu.be/${VIDEO_B}`,
    `https://www.youtube.com/shorts/${VIDEO_B}`,
    `https://music.youtube.com/watch?v=${VIDEO_B}`,
    `https://www.youtube.com/embed/${VIDEO_B}`,
  ]) {
    assert.equal(resolveTrackThumbnail(playing('URL', { url, duration: 5 })), `https://i.ytimg.com/vi/${VIDEO_B}/hqdefault.jpg`);
    assert.equal(resolveTrackWatchUrl(playing('URL', { url, duration: 5 })), `https://www.youtube.com/watch?v=${VIDEO_B}`);
  }

  const unsafe = playing('Unsafe', {
    url: 'not a url',
    duration: null,
    videoId: 'short',
    thumbnail: 'http://evil.example/thumb.jpg',
  });
  assert.equal(resolveTrackThumbnail(unsafe), null);
  assert.equal(resolveTrackWatchUrl(unsafe), null);
  assert.deepEqual(youtubeMediaFields({
    id: VIDEO_A,
    thumbnail: 'not-a-url',
    thumbnails: [
      { url: `https://i.ytimg.com/vi/${VIDEO_A}/default.jpg`, height: 90 },
      { url: 'https://evil.example/large.jpg', height: 9999 },
      { url: `https://i.ytimg.com/vi/${VIDEO_A}/hqdefault.jpg`, height: 360 },
    ],
  }), { videoId: VIDEO_A, thumbnail: `https://i.ytimg.com/vi/${VIDEO_A}/hqdefault.jpg` });
  assert.equal(extractYouTubeThumbnailUrl({
    url: `https://music.youtube.com/watch?v=${VIDEO_A}`,
    thumbnail: [
      { url: 'https://lh3.googleusercontent.com/artist', height: 800 },
      { url: `https://i.ytimg.com/vi/${VIDEO_A}/hqdefault.jpg`, height: 360 },
    ],
  }), `https://i.ytimg.com/vi/${VIDEO_A}/hqdefault.jpg`);

  const imported = musicResolverItemsToTracks([{
    videoId: VIDEO_A,
    title: 'Imported',
    thumbnail: `https://i.ytimg.com/vi/${VIDEO_A}/hqdefault.jpg`,
  }], 'user');
  assert.equal(imported[0].videoId, VIDEO_A);
  assert.equal(imported[0].url, `https://music.youtube.com/watch?v=${VIDEO_A}`);
  assert.equal(imported[0].thumbnail, `https://i.ytimg.com/vi/${VIDEO_A}/hqdefault.jpg`);
});

test('player image is per guild, links the original video, and survives a missing thumbnail', async () => {
  const m = new MusicManager();
  const a = m.getOrCreate('thumb-a');
  const b = m.getOrCreate('thumb-b');
  a.connection = {};
  b.connection = {};
  a.queue.setCurrent(playing('Alpha', {
    url: `https://music.youtube.com/watch?v=${VIDEO_B}`,
    duration: 90,
    videoId: VIDEO_A,
    thumbnail: `https://i.ytimg.com/vi/${VIDEO_A}/maxresdefault.jpg`,
  }));
  b.queue.setCurrent(playing('Beta', { url: `https://youtu.be/${VIDEO_B}`, duration: 61 }));
  const payloadA = panelPayload(m, 'thumb-a');
  const embedA = payloadA.embeds[0].toJSON();
  const embedB = panelPayload(m, 'thumb-b').embeds[0].toJSON();
  const buttons = ['spica:previous', 'spica:next', 'spica:mute', 'spica:unmute'];
  assert.equal(embedA.title, 'Alpha');
  assert.equal(embedA.url, `https://www.youtube.com/watch?v=${VIDEO_A}`);
  assert.equal(embedA.image.url, `https://i.ytimg.com/vi/${VIDEO_A}/maxresdefault.jpg`);
  assert.equal(embedA.thumbnail, undefined);
  assert.equal(embedA.fields.find((field) => field.name === '曲の長さ').value, '1:30');
  assert.deepEqual(payloadA.components[0].toJSON().components.map((button) => button.custom_id), buttons);
  assert.equal(embedB.title, 'Beta');
  assert.equal(embedB.url, `https://www.youtube.com/watch?v=${VIDEO_B}`);
  assert.equal(embedB.image.url, `https://i.ytimg.com/vi/${VIDEO_B}/hqdefault.jpg`);
  assert.notEqual(embedA.image.url, embedB.image.url);

  const missing = m.getOrCreate('thumb-missing');
  missing.connection = {};
  missing.queue.setCurrent(playing('No art', { url: 'not a url', duration: null, thumbnail: 'javascript:alert(1)' }));
  const embedMissing = panelPayload(m, 'thumb-missing').embeds[0].toJSON();
  assert.equal(embedMissing.title, 'No art');
  assert.equal(embedMissing.image, undefined);
  assert.equal(embedMissing.fields.find((field) => field.name === '曲の長さ').value, '--:--');
  assert.deepEqual(panelPayload(m, 'thumb-missing').components[0].toJSON().components.map((button) => button.custom_id), buttons);

  const editsA = [];
  const editsB = [];
  const channel = (edits) => ({ send: async () => ({ edit: async (payload) => edits.push(payload.embeds[0].toJSON()) }) });
  ensureAutoPanel(m, 'thumb-a', channel(editsA));
  ensureAutoPanel(m, 'thumb-b', channel(editsB));
  await new Promise((resolve) => setImmediate(resolve));
  a.queue.setCurrent(playing('Alpha 2', { url: `https://www.youtube.com/shorts/${VIDEO_A}`, duration: 12 }));
  refreshPanel(m, 'thumb-a');
  b.queue.setCurrent(playing('Beta 2', { url: 'not a url', duration: 40 }));
  refreshPanel(m, 'thumb-b');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(editsA.length, 1);
  assert.equal(editsB.length, 1);
  assert.equal(editsA[0].title, 'Alpha 2');
  assert.equal(editsA[0].image.url, `https://i.ytimg.com/vi/${VIDEO_A}/hqdefault.jpg`);
  assert.equal(editsA[0].url, `https://www.youtube.com/watch?v=${VIDEO_A}`);
  assert.equal(editsA[0].fields.find((field) => field.name === '曲の長さ').value, '0:12');
  assert.equal(editsB[0].title, 'Beta 2');
  assert.equal(editsB[0].image, undefined);
  assert.equal(editsB[0].fields.find((field) => field.name === '曲の長さ').value, '0:40');
  forgetPanel('thumb-a');
  forgetPanel('thumb-b');
});
