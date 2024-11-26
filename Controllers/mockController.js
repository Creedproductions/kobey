const mockData = [
    { id: 1, name: "Video 1", source: "YouTube", url: "https://youtube.com/video1" },
    { id: 2, name: "Video 2", source: "Vimeo", url: "https://vimeo.com/video2" },
    { id: 3, name: "Video 3", source: "Dailymotion", url: "https://dailymotion.com/video3" }
];

const getMockVideos = (req, res) => {
    res.status(200).json({
        success: true,
        data: mockData
    });
};

module.exports = {
    getMockVideos
};
