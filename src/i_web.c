// i_web.c -- Browser (Emscripten) platform layer for linuxdoom-1.10.
// Replaces i_main.c, i_system.c, i_video.c, i_sound.c and i_net.c.
// Video, input, sound and music are handed to the JavaScript shell (web/doom-shell.js).

#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <stdarg.h>
#include <unistd.h>
#include <sys/time.h>

#include "doomdef.h"
#include "doomstat.h"
#include "m_argv.h"
#include "m_misc.h"
#include "d_main.h"
#include "d_net.h"
#include "d_event.h"
#include "g_game.h"
#include "i_system.h"
#include "i_video.h"
#include "i_sound.h"
#include "i_net.h"
#include "v_video.h"
#include "w_wad.h"
#include "z_zone.h"
#include "sounds.h"

// After the Doom headers: em_js.h defines true/false macros that clash with doomtype.h
#include <emscripten.h>

// ---------------------------------------------------------------------------
// JavaScript bridge
// ---------------------------------------------------------------------------

EM_JS(void, js_blit, (const unsigned char* rgba, int w, int h), {
    Module.doomBlit(rgba, w, h);
});

EM_JS(int, js_poll_events, (int* buf, int max), {
    return Module.doomPollEvents(buf, max);
});

EM_JS(void, js_fatal, (const char* msg), {
    Module.doomFatal(UTF8ToString(msg));
});

EM_JS(void, js_quit, (void), {
    Module.doomQuit();
});

EM_JS(int, js_sfx_start, (int id, const unsigned char* data, int len, int vol, int sep, int pitch), {
    return Module.doomSfxStart(id, data, len, vol, sep, pitch);
});

EM_JS(void, js_sfx_stop, (int handle), { Module.doomSfxStop(handle); });
EM_JS(int, js_sfx_playing, (int handle), { return Module.doomSfxPlaying(handle); });
EM_JS(void, js_sfx_update, (int handle, int vol, int sep, int pitch), {
    Module.doomSfxUpdate(handle, vol, sep, pitch);
});

EM_JS(int, js_music_register, (const unsigned char* data, int len), {
    return Module.doomMusicRegister(data, len);
});
EM_JS(void, js_music_play, (int handle, int looping), { Module.doomMusicPlay(handle, looping); });
EM_JS(void, js_music_stop, (void), { Module.doomMusicStop(); });
EM_JS(void, js_music_pause, (int paused), { Module.doomMusicPause(paused); });
EM_JS(void, js_music_volume, (int vol), { Module.doomMusicVolume(vol); });

// Lets the browser run (paint, input, audio) while Doom waits.
void I_Yield (void)
{
    emscripten_sleep(1);
}

// Exposed so the shell knows whether to map gamepad buttons to menu keys.
// 0 = playing, 1 = menu open, 2 = menu message waiting for y/n
extern int messageToPrint;
extern boolean messageNeedsInput;

EMSCRIPTEN_KEEPALIVE int web_menu_state (void)
{
    if (menuactive && messageToPrint && messageNeedsInput)
        return 2;
    if (menuactive)
        return 1;
    if (gamestate != GS_LEVEL)
        return 3;   // title / intermission / finale
    return 0;
}

// Pending weapon cycle request (+1 next / -1 previous), consumed in G_BuildTiccmd.
int web_weapon_cycle = 0;

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

int mb_used = 16;
char* sndserver_filename = "sndserver";   // only referenced by the config file table

void I_Tactile (int on, int off, int total)
{
    on = off = total = 0;
}

ticcmd_t emptycmd;
ticcmd_t* I_BaseTiccmd (void)
{
    return &emptycmd;
}

int I_GetHeapSize (void)
{
    return mb_used*1024*1024;
}

byte* I_ZoneBase (int* size)
{
    *size = mb_used*1024*1024;
    return (byte *) malloc (*size);
}

int I_GetTime (void)
{
    static double basetime = 0;
    double now = emscripten_get_now();      // milliseconds
    if (!basetime)
        basetime = now;
    return (int)((now - basetime) * TICRATE / 1000.0);
}

void I_Init (void)
{
    I_InitSound();
}

void I_Quit (void)
{
    D_QuitNetGame ();
    I_ShutdownSound();
    I_ShutdownMusic();
    M_SaveDefaults ();
    I_ShutdownGraphics();
    js_quit();
    emscripten_force_exit(0);
}

void I_WaitVBL (int count)
{
    emscripten_sleep(count * 1000 / 70);
}

void I_BeginRead (void) {}
void I_EndRead (void) {}

byte* I_AllocLow (int length)
{
    byte* mem = (byte *)malloc (length);
    memset (mem,0,length);
    return mem;
}

extern boolean demorecording;

void I_Error (char *error, ...)
{
    char msg[1024];
    va_list argptr;

    va_start (argptr,error);
    vsnprintf (msg, sizeof(msg), error, argptr);
    va_end (argptr);

    fprintf (stderr, "Error: %s\n", msg);
    js_fatal(msg);

    if (demorecording)
        G_CheckDemoStatus();

    D_QuitNetGame ();
    I_ShutdownGraphics();
    emscripten_force_exit(1);
}

// ---------------------------------------------------------------------------
// Network (single player only)
// ---------------------------------------------------------------------------

void I_InitNetwork (void)
{
    int i;

    doomcom = malloc (sizeof (*doomcom));
    memset (doomcom, 0, sizeof(*doomcom));

    i = M_CheckParm ("-dup");
    if (i && i < myargc-1)
    {
        doomcom->ticdup = myargv[i+1][0]-'0';
        if (doomcom->ticdup < 1) doomcom->ticdup = 1;
        if (doomcom->ticdup > 9) doomcom->ticdup = 9;
    }
    else
        doomcom->ticdup = 1;

    doomcom->extratics = 0;
    netgame = false;
    doomcom->id = DOOMCOM_ID;
    doomcom->numplayers = doomcom->numnodes = 1;
    doomcom->deathmatch = false;
    doomcom->consoleplayer = 0;
}

void I_NetCmd (void)
{
    // No network in the browser build.
}

// ---------------------------------------------------------------------------
// Video
// ---------------------------------------------------------------------------

static unsigned int palette_rgba[256];
static unsigned int framebuffer[SCREENWIDTH*SCREENHEIGHT];

void I_InitGraphics (void)
{
    static int firsttime = 1;
    if (!firsttime)
        return;
    firsttime = 0;
}

void I_ShutdownGraphics (void) {}

void I_SetPalette (byte* palette)
{
    int i;
    for (i = 0; i < 256; i++)
    {
        unsigned int r = gammatable[usegamma][*palette++];
        unsigned int g = gammatable[usegamma][*palette++];
        unsigned int b = gammatable[usegamma][*palette++];
        // little-endian RGBA for ImageData
        palette_rgba[i] = 0xff000000u | (b << 16) | (g << 8) | r;
    }
}

void I_UpdateNoBlit (void) {}

void I_FinishUpdate (void)
{
    static int lasttic;
    int i, tics;
    byte* src = screens[0];

    // draws little dots on the bottom of the screen (-devparm)
    if (devparm)
    {
        i = I_GetTime();
        tics = i - lasttic;
        lasttic = i;
        if (tics > 20) tics = 20;
        for (i=0 ; i<tics*2 ; i+=2)
            screens[0][ (SCREENHEIGHT-1)*SCREENWIDTH + i] = 0xff;
        for ( ; i<20*2 ; i+=2)
            screens[0][ (SCREENHEIGHT-1)*SCREENWIDTH + i] = 0x0;
    }

    for (i = 0; i < SCREENWIDTH*SCREENHEIGHT; i++)
        framebuffer[i] = palette_rgba[src[i]];

    js_blit((const unsigned char*)framebuffer, SCREENWIDTH, SCREENHEIGHT);
}

void I_ReadScreen (byte* scr)
{
    memcpy (scr, screens[0], SCREENWIDTH*SCREENHEIGHT);
}

void I_StartFrame (void) {}

// Event types coming from the shell (in addition to evtype_t).
#define WEB_EV_WEAPONCYCLE 100

void I_StartTic (void)
{
    static int buf[64*4];
    int n, i;
    event_t ev;

    n = js_poll_events(buf, 64);
    for (i = 0; i < n; i++)
    {
        int* e = &buf[i*4];
        if (e[0] == WEB_EV_WEAPONCYCLE)
        {
            web_weapon_cycle = e[1];
            continue;
        }
        ev.type = (evtype_t)e[0];
        ev.data1 = e[1];
        ev.data2 = e[2];
        ev.data3 = e[3];
        D_PostEvent(&ev);
    }
}

// ---------------------------------------------------------------------------
// Sound effects (played by WebAudio in the shell)
// ---------------------------------------------------------------------------

void I_InitSound (void) {}
void I_UpdateSound (void) {}
void I_SubmitSound (void) {}
void I_ShutdownSound (void) {}
void I_SetChannels (void) {}

void I_SetSfxVolume (int volume)
{
    snd_SfxVolume = volume;
}

int I_GetSfxLumpNum (sfxinfo_t* sfx)
{
    char namebuf[9];
    sfxinfo_t* orig = sfx;
    int lump;
    if (sfx->link)
        sfx = sfx->link;
    sprintf(namebuf, "ds%s", sfx->name);
    lump = W_CheckNumForName(namebuf);
    // s_sound.c expects ->data to be set once the sound is cached
    if (lump >= 0 && !orig->data)
        orig->data = W_CacheLumpNum(lump, PU_STATIC);
    return lump;
}

int I_StartSound (int id, int vol, int sep, int pitch, int priority)
{
    sfxinfo_t* sfx = &S_sfx[id];
    int lump;
    byte* data;

    priority = 0;
    lump = sfx->lumpnum;
    if (lump < 0)
        lump = sfx->lumpnum = I_GetSfxLumpNum(sfx);
    if (lump < 0)
        return -1;

    data = W_CacheLumpNum(lump, PU_STATIC);
    return js_sfx_start(sfx->link ? (sfx->link - S_sfx) : id,
                        data, W_LumpLength(lump), vol, sep, pitch);
}

void I_StopSound (int handle)
{
    js_sfx_stop(handle);
}

int I_SoundIsPlaying (int handle)
{
    return js_sfx_playing(handle);
}

void I_UpdateSoundParams (int handle, int vol, int sep, int pitch)
{
    js_sfx_update(handle, vol, sep, pitch);
}

// ---------------------------------------------------------------------------
// Music (MUS lumps are played by a small synthesizer in the shell)
// ---------------------------------------------------------------------------

void I_InitMusic (void) {}
void I_ShutdownMusic (void) { js_music_stop(); }

void I_SetMusicVolume (int volume)
{
    snd_MusicVolume = volume;
    js_music_volume(volume);
}

void I_PauseSong (int handle)  { handle = 0; js_music_pause(1); }
void I_ResumeSong (int handle) { handle = 0; js_music_pause(0); }

int I_RegisterSong (void* data)
{
    unsigned char* d = (unsigned char*)data;
    int len;
    if (d[0] != 'M' || d[1] != 'U' || d[2] != 'S')
        return 0;
    // header: scoreLen (u16 @4), scoreStart (u16 @6)
    len = (d[4] | (d[5] << 8)) + (d[6] | (d[7] << 8));
    return js_music_register(d, len);
}

void I_PlaySong (int handle, int looping)
{
    if (handle)
        js_music_play(handle, looping);
}

void I_StopSong (int handle)
{
    handle = 0;
    js_music_stop();
}

void I_UnRegisterSong (int handle)
{
    handle = 0;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

int main (int argc, char** argv)
{
    myargc = argc;
    myargv = argv;

    // Config (.doomrc) and savegames live in the persistent home directory.
    chdir("/home/web_user");

    D_DoomMain ();
    return 0;
}
