import os



def rename_images_in_directory(directory):
    # remove all the spaces from the names of each file before .png
    for filename in os.listdir(directory):
        if filename.endswith(".png"):
            new_filename = filename.replace(" ", "")
            os.rename(os.path.join(directory, filename), os.path.join(directory, new_filename))
            print(f"Renamed: {filename} -> {new_filename}")
    
            
if __name__ == "__main__":
    directory = input("Enter the directory path containing images: ")
    rename_images_in_directory(directory)