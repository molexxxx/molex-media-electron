import { link } from '../parts.js';

$.component('download-page', {
    render()
    {
        return `
<div class="wrap">
    <header class="page-head">
        <h1>Download molexMedia</h1>
        <p class="lead">Free and open source under the MIT license. No account needed. The newest release for each system is below, with the steps to install it.</p>
    </header>
    <div class="dl-grid">
        <div>
            <h2 class="sr">Installers</h2>
            <platform-list detail="true"></platform-list>
        </div>
        <div>
            <div class="steps">
                <h2>After installing</h2>
                <ol>
                    <li>Open molexMedia. It looks for FFmpeg and ffprobe on your system first.</li>
                    <li>If they are missing, the setup wizard downloads a current build: from BtbN's FFmpeg builds on Windows and Linux, and from evermeet.cx on macOS.</li>
                    <li>If the download fails, retry, or install FFmpeg yourself, add it to your PATH, and choose <strong>I have it</strong>.</li>
                    <li>yt-dlp is downloaded the first time you paste a URL into the player.</li>
                </ol>
            </div>
            <div class="steps">
                <h2>Other ways to get it</h2>
                <ul class="bullets">
                    <li>Every past version is on the <a href="https://github.com/molexxxx/molex-media-electron/releases" rel="noopener">GitHub releases page</a>.</li>
                    <li>Build it yourself from the <a href="https://github.com/molexxxx/molex-media-electron" rel="noopener">source code</a> with Node.js: <code>npm install</code>, then <code>npm run package</code> to build an installer for your system.</li>
                    <li>See what changed in each release in the ${link('/changelog', 'changelog')}.</li>
                </ul>
            </div>
        </div>
    </div>
</div>`;
    },
});
