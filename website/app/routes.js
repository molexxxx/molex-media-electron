export const routes = [
    {
        path: '/',
        component: 'home-page',
        title: 'molexMedia: batch, edit, and play media on FFmpeg',
        description: 'molexMedia is a free desktop app for Windows, macOS, and Linux with a batch processor, a multi-track timeline editor, and a media player, built on FFmpeg.',
    },
    {
        path: '/features',
        component: 'features-page',
        title: 'Features | molexMedia',
        description: 'What the Batch Processor, Media Editor, and Media Player do, plus setup, the tray, logs, and updates.',
    },
    {
        path: '/features/batch',
        component: 'batch-page',
        title: 'Batch Processor | molexMedia',
        description: 'Normalize, boost, convert, compress, and extract across a queue of files, with the presets, encoders, and FFmpeg details listed.',
    },
    {
        path: '/features/editor',
        component: 'editor-page',
        title: 'Media Editor | molexMedia',
        description: 'A multi-track timeline with edits, trims, transforms, keyframes, blend modes, clip export, and a stream inspector.',
    },
    {
        path: '/features/player',
        component: 'player-page',
        title: 'Media Player | molexMedia',
        description: 'Play local files and stream YouTube or direct audio links with eight real-time visualizations and a popout player.',
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
        description: 'Every molexMedia release and what changed, including the 4.6 and 4.7 audio and encoder fixes.',
    },
];

export default routes;
