https://tectonic-hydrology.github.io/HYDROTHERM/

# Scalar Data Visualizer

A modern web application for visualizing large scientific data files with interactive plotting capabilities.

## Features

- **File Upload**: Supports HYDROTHERM Plot_scalar and Plot_vector data files
- **Variable Selection**: Choose from Temperature, Pressure, Saturation, and Phase variables
- **Colormap Options**: Multiple colormap options including Viridis, Plasma, Inferno, and more
- **Time Navigation**: Interactive slider to navigate through different time points
- **Real-time Updates**: Instant visualization updates when changing variables or colormaps
- **Responsive Design**: Modern, mobile-friendly interface
- **Large File Support**: Optimized for processing large data files (400k+ lines)

## How to Use

1. **Open the Application**: Open `index.html` in a modern web browser
2. **Select Data File**: Click "Choose File" and select your data file
3. **Choose Variable**: Select the scalar variable you want to visualize from the dropdown
4. **Pick Colormap**: Choose your preferred colormap from the available options
5. **Load & Plot**: Click "Load & Plot" to process the file and generate the visualization
6. **Navigate Time**: Use the slider to move through different time points
7. **Interact**: Hover over data points for detailed information, use Plotly's built-in tools for zooming and panning

## Data Format

The application expects data files with the following structure:

- Columns: x, y, z, time, temperature, pressure, saturation, phase
- Scientific notation support (e.g., 1.250000E-02)
- Header lines are automatically detected and skipped
- Large files are processed efficiently using streaming techniques

## Keyboard Navigation

- **Left Arrow**: Previous time point
- **Right Arrow**: Next time point

## Technical Details

- **Frontend**: HTML5, CSS3, JavaScript (ES6+)
- **Visualization**: Plotly.js for interactive plotting
- **Styling**: Bootstrap 5 with custom gradients and animations
- **File Processing**: Client-side parsing with error handling
- **Performance**: Optimized for large datasets with efficient data structures

## Browser Compatibility

- Chrome 80+
- Firefox 75+
- Safari 13+
- Edge 80+

## File Size Considerations

The application is designed to handle large files efficiently:

- Files up to several hundred MB can be processed
- Memory usage is optimized for large datasets
- Progress indicators show processing status
- Error handling for malformed data

## Troubleshooting

- **File not loading**: Ensure the file format is supported (.h13d18, .mid12, .noig)
- **No data displayed**: Check that the file contains valid numeric data in the expected format
- **Slow performance**: Large files may take time to process; wait for the loading indicator to complete
- **Browser issues**: Try refreshing the page or using a different browser

## Example Data Structure

```
x (km)    y (km)    z (km)    time (yr)    temp (°C)    pressure (Pa)    saturation    phase
1.250E-02 0.500000  0.250000  0.00000      1100.00      7.000000E+08     -1.00000      4
2.600E-02 0.500000  0.250000  0.00000      254.139      4.188769E+08     0.500000      1
```

## License

This application is provided as-is for educational and research purposes. 
