import { link } from '../parts.js';

$.component('download-page', {
    render()
    {
        return `
<div class="wrap">
    <header class="page-head">
        <h1>Download molexMedia</h1>
        <p class="lead">Free and open source under the MIT license. No account needed. The newest release for each system is below, with the steps to install it. The version and file sizes come from the release itself.</p>
    </header>
    <div class="dl-grid">
        <div>
            <h2 class="sr">Installers</h2>
            <platform-list detail="true"></platform-list>
        </div>
        <div class="dl-aside">
            <div class="steps">
                <h2>After installing</h2>
                <ol>
                    <li>Open molexMedia. It looks for FFmpeg and ffprobe on your computer first and uses them when they are at least version 5.1.</li>
                    <li>If they are missing or too old, it downloads a pinned build, checks the size and SHA-256 against the pin, extracts it, and runs a self-test before the install counts. You can also choose a folder that already holds both tools.</li>
                    <li>Drop files on Batch, choose an operation, read the Review, and press Start.</li>
                    <li>The Player installs yt-dlp the first time it needs it and keeps it current from then on.</li>
                </ol>
            </div>
            <div>
                <h2>Other ways to get it</h2>
                <ul class="bullets">
                    <li>Every past version is on the <a href="https://github.com/molexxxx/molex-media-electron/releases" rel="noopener">GitHub releases page</a>.</li>
                    <li>Build it yourself from the <a href="https://github.com/molexxxx/molex-media-electron" rel="noopener">source code</a> with Node.js: <code>npm install</code>, then <code>npm run package:win</code>, <code>package:mac</code>, or <code>package:linux</code>.</li>
                    <li>See what changed in each release in the ${link('/changelog', 'changelog')}.</li>
                </ul>
            </div>
        </div>
    </div>
</div>`;
    },
});
