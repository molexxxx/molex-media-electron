export const routes = [
    {
        path: '/',
        component: 'home-page',
        title: 'molexMedia: batch, trim, and play media on FFmpeg',
        description: 'molexMedia is a free desktop app for Windows, macOS, and Linux. It normalizes, converts, and compresses batches of media to named standards, trims and edits on a timeline, and plays files and links, all on FFmpeg.',
    },
    {
        path: '/features',
        component: 'features-page',
        title: 'Features | molexMedia',
        description: 'What Batch, the Editor, and the Player do, plus first-run setup, hardware encoding, logs, and updates.',
    },
    {
        path: '/features/batch',
        component: 'batch-page',
        title: 'Batch | molexMedia',
        description: 'Normalize to named loudness standards, apply gain, convert, compress, and extract across a queue, with a Review step and a measured stamp on every finished job.',
    },
    {
        path: '/features/editor',
        component: 'editor-page',
        title: 'Editor | molexMedia',
        description: 'Trim one file between in and out points, arrange clips from several files on a timeline, and inspect streams and tags.',
    },
    {
        path: '/features/player',
        component: 'player-page',
        title: 'Player | molexMedia',
        description: 'Play local files and links through yt-dlp, with video, subtitles, audio tracks, real full screen, visualizations, and a pop-out window.',
    },
    {
        path: '/download',
        component: 'download-page',
        title: 'Download | molexMedia',
        description: 'Download molexMedia for Windows, macOS, or Linux, with install notes for each system.',
    },
    {
        path: '/changelog',
        component: 'changelog-page',
        title: 'Changelog | molexMedia',
        description: 'Every molexMedia release and what changed.',
    },
];

export default routes;
